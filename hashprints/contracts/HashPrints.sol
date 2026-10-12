// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @title HashPrints — 3,333 prints pressed from proof-of-work.
/// @notice EXPERIMENTAL. Internally reviewed, not professionally audited. Max two public prints per wallet.
///   Minting ("pressing") takes two things:
///   1. Grind: a nonce such that keccak256(abi.encode(this, minter, nonce)) has at least
///      `difficulty()` leading zero bits. The hash becomes the print's seed.
///   2. Press: ETH at a Dutch price. Each run of 333 opens at 4x the floor and cools
///      linearly to the floor over 33 minutes. Each zero bit beyond the requirement
///      halves the premium, so extra work buys a cheaper (and rarer) print.
contract HashPrints is ERC721, Ownable2Step {
    uint256 public constant MAX_SUPPLY = 3333;
    uint256 public constant ARTIST_PROOFS = 3;
    uint256 public constant RUN_SIZE = 333;
    uint256 public constant RUNS = 10;
    uint256 public constant START_MULTIPLIER = 4;
    uint256 public constant DECAY = 33 minutes;
    uint256 public constant BASE_DIFFICULTY = 16;
    uint256 public constant MAX_PER_WALLET = 2;

    // Everything the press reads on a mint lives in one slot.
    struct State {
        uint128 floorPrice;
        uint64 runStartedAt; // 0 while the press is closed
        uint16 pressed; // public mints so far
        uint8 artistProofsPressed;
        bool baseURILocked;
    }

    State private _state;
    string private _baseTokenURI;

    mapping(uint256 tokenId => bytes32) public seedOf;

    // Per wallet: mint count in the top 8 bits, first seed below it. A valid seed always has
    // at least 16 leading zero bits, so the two never overlap. Comparing against the first
    // seed is enough to stop a wallet pressing the same proof twice under a limit of two.
    mapping(address minter => uint256) private _wallet;
    uint256 private constant COUNT_SHIFT = 248;
    uint256 private constant SEED_MASK = (1 << COUNT_SHIFT) - 1;

    event PressOpened(uint256 floorPrice, uint256 at);
    event RunStarted(uint256 indexed run, uint256 difficulty, uint256 at);
    event Pressed(
        uint256 indexed tokenId,
        address indexed minter,
        bytes32 seed,
        uint256 run,
        uint256 difficulty,
        uint256 extraBits,
        uint256 price
    );
    event BaseURILocked(string baseURI);
    event FloorPriceSet(uint256 floorPrice);

    error PressClosed();
    error PressAlreadyOpen();
    error SoldOut();
    error InsufficientWork(uint256 bits, uint256 required);
    error ProofAlreadyUsed();
    error Underpaid(uint256 price, uint256 sent);
    error WalletLimitReached();
    error TransferFailed();
    error BaseURIIsLocked();
    error FloorTooHigh();
    error ZeroAddress();

    constructor(uint256 floorPrice_, string memory baseURI_) ERC721("HashPrints", "HASHPRINT") Ownable(msg.sender) {
        if (floorPrice_ > type(uint128).max) revert FloorTooHigh();
        _state.floorPrice = uint128(floorPrice_);
        _baseTokenURI = baseURI_;
    }

    // ------------------------------------------------------------------ views

    function floorPrice() external view returns (uint256) {
        return _state.floorPrice;
    }

    function runStartedAt() external view returns (uint256) {
        return _state.runStartedAt;
    }

    function pressed() external view returns (uint256) {
        return _state.pressed;
    }

    function artistProofsPressed() external view returns (uint256) {
        return _state.artistProofsPressed;
    }

    function baseURILocked() external view returns (bool) {
        return _state.baseURILocked;
    }

    function totalSupply() external view returns (uint256) {
        return uint256(_state.pressed) + _state.artistProofsPressed;
    }

    function pressedBy(address minter) external view returns (uint256) {
        return _wallet[minter] >> COUNT_SHIFT;
    }

    function currentRun() public view returns (uint256) {
        return _state.pressed / RUN_SIZE;
    }

    /// @notice Required leading zero bits: 16, rising one bit every two runs (to 20).
    function difficulty() public view returns (uint256) {
        return _difficultyForRun(currentRun());
    }

    /// @notice The difficulty a token was pressed at, derived from its id.
    function difficultyOf(uint256 tokenId) public view returns (uint256) {
        _requireOwned(tokenId);
        if (tokenId <= ARTIST_PROOFS) return BASE_DIFFICULTY;
        return _difficultyForRun((tokenId - ARTIST_PROOFS - 1) / RUN_SIZE);
    }

    function proofHash(address minter, uint256 nonce) public view returns (bytes32) {
        return keccak256(abi.encode(address(this), minter, nonce));
    }

    function leadingZeroBits(bytes32 h) public pure returns (uint256 n) {
        uint256 x = uint256(h);
        if (x == 0) return 256;
        for (uint256 step = 128; step > 0; step >>= 1) {
            if (x >> (256 - step) == 0) {
                n += step;
                x <<= step;
            }
        }
    }

    /// @notice Price right now for a proof with `extraBits` zero bits beyond the requirement.
    function priceFor(uint256 extraBits) public view returns (uint256) {
        State memory s = _state;
        if (s.runStartedAt == 0) revert PressClosed();
        return _priceFor(s, extraBits);
    }

    function currentPrice() external view returns (uint256) {
        return priceFor(0);
    }

    /// @notice `<baseURI><id>?seed=<seed>&d=<difficulty>` — the seed comes from chain, so the
    /// metadata server can render traits without trusting anything but this URL.
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        uint256 d = difficultyOf(tokenId); // reverts for unminted ids
        return string.concat(
            _baseTokenURI,
            Strings.toString(tokenId),
            "?seed=",
            Strings.toHexString(uint256(seedOf[tokenId]), 32),
            "&d=",
            Strings.toString(d)
        );
    }

    // ------------------------------------------------------------------ press

    /// @notice Mint one print with a ground nonce. Overpayment is refunded.
    function press(uint256 nonce) external payable returns (uint256 tokenId) {
        State memory s = _state;
        if (s.runStartedAt == 0) revert PressClosed();
        if (s.pressed >= RUN_SIZE * RUNS) revert SoldOut();

        uint256 wallet = _wallet[msg.sender];
        uint256 count = wallet >> COUNT_SHIFT;
        if (count >= MAX_PER_WALLET) revert WalletLimitReached();

        bytes32 seed = proofHash(msg.sender, nonce);
        uint256 run = s.pressed / RUN_SIZE;
        uint256 required = _difficultyForRun(run);
        uint256 bits = leadingZeroBits(seed);
        if (bits < required) revert InsufficientWork(bits, required);
        if (count != 0 && (wallet & SEED_MASK) == uint256(seed)) revert ProofAlreadyUsed();

        uint256 extraBits = bits - required;
        uint256 price = _priceFor(s, extraBits);
        if (msg.value < price) revert Underpaid(price, msg.value);

        // Effects. Keep the first seed; only the count changes on the second press.
        _wallet[msg.sender] = count == 0 ? (1 << COUNT_SHIFT) | uint256(seed) : wallet + (1 << COUNT_SHIFT);
        s.pressed += 1;
        tokenId = ARTIST_PROOFS + s.pressed; // ids 1-3 are artist proofs
        seedOf[tokenId] = seed;

        // Selling out a run re-inks the press: next run opens hot, harder every two runs.
        if (s.pressed % RUN_SIZE == 0 && s.pressed < RUN_SIZE * RUNS) {
            s.runStartedAt = uint64(block.timestamp);
            emit RunStarted(run + 1, _difficultyForRun(run + 1), block.timestamp);
        }
        _state = s;

        emit Pressed(tokenId, msg.sender, seed, run, required, extraBits, price);

        // Interactions.
        _safeMint(msg.sender, tokenId);
        if (msg.value > price) {
            (bool ok,) = msg.sender.call{value: msg.value - price}("");
            if (!ok) revert TransferFailed();
        }
    }

    // ------------------------------------------------------------------ owner

    /// @notice Artist proofs still need work at the base difficulty, but are free.
    function pressArtistProof(uint256 nonce) external onlyOwner returns (uint256 tokenId) {
        uint256 done = _state.artistProofsPressed;
        if (done >= ARTIST_PROOFS) revert SoldOut();
        bytes32 seed = proofHash(msg.sender, nonce);
        uint256 bits = leadingZeroBits(seed);
        if (bits < BASE_DIFFICULTY) revert InsufficientWork(bits, BASE_DIFFICULTY);
        for (uint256 id = 1; id <= done; id++) {
            if (seedOf[id] == seed) revert ProofAlreadyUsed();
        }
        tokenId = done + 1;
        _state.artistProofsPressed = uint8(tokenId);
        seedOf[tokenId] = seed;
        emit Pressed(tokenId, msg.sender, seed, 0, BASE_DIFFICULTY, bits - BASE_DIFFICULTY, 0);
        _safeMint(msg.sender, tokenId);
    }

    function openPress() external onlyOwner {
        if (_state.runStartedAt != 0) revert PressAlreadyOpen();
        _state.runStartedAt = uint64(block.timestamp);
        emit PressOpened(_state.floorPrice, block.timestamp);
        emit RunStarted(0, BASE_DIFFICULTY, block.timestamp);
    }

    /// @notice The floor can only be set before the press opens, so buyers know it's fixed.
    function setFloorPrice(uint256 floorPrice_) external onlyOwner {
        if (_state.runStartedAt != 0) revert PressAlreadyOpen();
        if (floorPrice_ > type(uint128).max) revert FloorTooHigh();
        _state.floorPrice = uint128(floorPrice_);
        emit FloorPriceSet(floorPrice_);
    }

    function setBaseURI(string calldata baseURI_) external onlyOwner {
        if (_state.baseURILocked) revert BaseURIIsLocked();
        _baseTokenURI = baseURI_;
    }

    /// @notice One-way: freezes where metadata lives so holders know it can't be swapped.
    function lockBaseURI() external onlyOwner {
        _state.baseURILocked = true;
        emit BaseURILocked(_baseTokenURI);
    }

    function withdraw(address payable to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        (bool ok,) = to.call{value: address(this).balance}("");
        if (!ok) revert TransferFailed();
    }

    // ------------------------------------------------------------------ internal

    function _difficultyForRun(uint256 run) private pure returns (uint256) {
        return BASE_DIFFICULTY + run / 2;
    }

    function _priceFor(State memory s, uint256 extraBits) private view returns (uint256) {
        uint256 elapsed = block.timestamp - s.runStartedAt;
        uint256 floor = s.floorPrice;
        uint256 premium = elapsed >= DECAY ? 0 : (floor * (START_MULTIPLIER - 1) * (DECAY - elapsed)) / DECAY;
        premium = extraBits >= 256 ? 0 : premium >> extraBits;
        return floor + premium;
    }
}
