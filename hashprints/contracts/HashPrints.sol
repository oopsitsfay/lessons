// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @title HashPrints — pixel prints pressed from proof-of-work.
/// @notice EXPERIMENTAL. Internally reviewed, not professionally audited.
///   Minting ("pressing") needs a nonce such that keccak256(abi.encode(this, minter, nonce))
///   has at least `difficulty()` leading zero bits, plus exactly `price()` in ETH (gas on top).
///   The hash becomes the print's seed. Extra zero bits make a rarer print, never a cheaper one.
///   Supply shape is set at deploy time, so the same code runs the main 3,333 edition
///   (10 runs × 333 + 3 artist proofs) and small live tests such as Test HashPrint (2 × 5).
contract HashPrints is ERC721, Ownable2Step {
    uint256 public constant BASE_DIFFICULTY = 16;
    uint256 public constant MAX_PER_WALLET = 2;

    uint256 public immutable RUN_SIZE;
    uint256 public immutable RUNS;
    uint256 public immutable ARTIST_PROOFS;
    uint256 public immutable MAX_SUPPLY;

    // Everything the press reads on a mint lives in one slot.
    struct State {
        uint128 price;
        uint64 openedAt; // 0 while the press is closed
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

    event PressOpened(uint256 price, uint256 at);
    event RunStarted(uint256 indexed run, uint256 difficulty, uint256 at);
    event Pressed(
        uint256 indexed tokenId, address indexed minter, bytes32 seed, uint256 run, uint256 difficulty, uint256 extraBits
    );
    event PriceSet(uint256 price);
    event BaseURILocked(string baseURI);

    error PressClosed();
    error PressAlreadyOpen();
    error SoldOut();
    error InsufficientWork(uint256 bits, uint256 required);
    error ProofAlreadyUsed();
    error WrongPayment(uint256 price, uint256 sent);
    error WalletLimitReached();
    error TransferFailed();
    error BaseURIIsLocked();
    error BadConfig();
    error ZeroAddress();

    constructor(
        string memory name_,
        string memory symbol_,
        uint256 price_,
        string memory baseURI_,
        uint256 runSize_,
        uint256 runs_,
        uint256 artistProofs_
    ) ERC721(name_, symbol_) Ownable(msg.sender) {
        if (
            runSize_ == 0 || runs_ == 0 || runSize_ * runs_ > type(uint16).max || artistProofs_ > type(uint8).max
                || price_ > type(uint128).max
        ) revert BadConfig();
        RUN_SIZE = runSize_;
        RUNS = runs_;
        ARTIST_PROOFS = artistProofs_;
        MAX_SUPPLY = runSize_ * runs_ + artistProofs_;
        _state.price = uint128(price_);
        _baseTokenURI = baseURI_;
    }

    // ------------------------------------------------------------------ views

    function price() external view returns (uint256) {
        return _state.price;
    }

    function openedAt() external view returns (uint256) {
        return _state.openedAt;
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

    /// @notice Required leading zero bits: 16, rising one bit every two runs.
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

    /// @notice Mint one print with a ground nonce. Send exactly `price()`.
    function press(uint256 nonce) external payable returns (uint256 tokenId) {
        State memory s = _state;
        if (s.openedAt == 0) revert PressClosed();
        if (s.pressed >= RUN_SIZE * RUNS) revert SoldOut();
        if (msg.value != s.price) revert WrongPayment(s.price, msg.value);

        uint256 wallet = _wallet[msg.sender];
        uint256 count = wallet >> COUNT_SHIFT;
        if (count >= MAX_PER_WALLET) revert WalletLimitReached();

        bytes32 seed = proofHash(msg.sender, nonce);
        uint256 run = s.pressed / RUN_SIZE;
        uint256 required = _difficultyForRun(run);
        uint256 bits = leadingZeroBits(seed);
        if (bits < required) revert InsufficientWork(bits, required);
        if (count != 0 && (wallet & SEED_MASK) == uint256(seed)) revert ProofAlreadyUsed();

        // Effects. Keep the first seed; only the count changes on the second press.
        _wallet[msg.sender] = count == 0 ? (1 << COUNT_SHIFT) | uint256(seed) : wallet + (1 << COUNT_SHIFT);
        s.pressed += 1;
        tokenId = ARTIST_PROOFS + s.pressed; // artist proofs take the first ids
        seedOf[tokenId] = seed;
        _state = s;

        if (s.pressed % RUN_SIZE == 0 && s.pressed < RUN_SIZE * RUNS) {
            emit RunStarted(run + 1, _difficultyForRun(run + 1), block.timestamp);
        }
        emit Pressed(tokenId, msg.sender, seed, run, required, bits - required);

        // Interaction last.
        _safeMint(msg.sender, tokenId);
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
        emit Pressed(tokenId, msg.sender, seed, 0, BASE_DIFFICULTY, bits - BASE_DIFFICULTY);
        _safeMint(msg.sender, tokenId);
    }

    function openPress() external onlyOwner {
        if (_state.openedAt != 0) revert PressAlreadyOpen();
        _state.openedAt = uint64(block.timestamp);
        emit PressOpened(_state.price, block.timestamp);
        emit RunStarted(0, BASE_DIFFICULTY, block.timestamp);
    }

    /// @notice The price can only be set before the press opens, so every minter pays the same.
    function setPrice(uint256 price_) external onlyOwner {
        if (_state.openedAt != 0) revert PressAlreadyOpen();
        if (price_ > type(uint128).max) revert BadConfig();
        _state.price = uint128(price_);
        emit PriceSet(price_);
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
}
