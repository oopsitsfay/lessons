// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title HashPrints — 3,333 prints pressed from proof-of-work.
/// @notice EXPERIMENTAL, UNAUDITED. Max two public prints per wallet. Minting ("pressing") takes two things:
///   1. Grind: a nonce such that keccak256(abi.encode(this, minter, nonce)) has at least
///      `difficulty()` leading zero bits. The hash becomes the print's seed.
///   2. Press: ETH at a Dutch price. Each run of 333 opens at 4x the floor and cools
///      linearly to the floor over 33 minutes. Each zero bit beyond the requirement
///      halves the premium, so extra work buys a cheaper (and rarer) print.
contract HashPrints is ERC721, Ownable {
    uint256 public constant MAX_SUPPLY = 3333;
    uint256 public constant ARTIST_PROOFS = 3;
    uint256 public constant RUN_SIZE = 333;
    uint256 public constant RUNS = 10;
    uint256 public constant START_MULTIPLIER = 4;
    uint256 public constant DECAY = 33 minutes;
    uint256 public constant BASE_DIFFICULTY = 16;
    uint256 public constant MAX_PER_WALLET = 2;

    uint256 public floorPrice;
    uint256 public runStartedAt; // 0 while the press is closed
    uint256 public pressed; // public mints so far
    uint256 public artistProofsPressed;
    string private baseURI;

    mapping(uint256 tokenId => bytes32) public seedOf;
    mapping(uint256 tokenId => uint256) public difficultyOf;
    mapping(bytes32 proof => bool) public proofUsed;
    mapping(address minter => uint256) public pressedBy;

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

    error PressClosed();
    error PressAlreadyOpen();
    error SoldOut();
    error InsufficientWork(uint256 bits, uint256 required);
    error ProofAlreadyUsed();
    error Underpaid(uint256 price, uint256 sent);
    error WalletLimitReached();
    error TransferFailed();

    constructor(uint256 floorPrice_, string memory baseURI_) ERC721("HashPrints", "HASHPRINT") Ownable(msg.sender) {
        floorPrice = floorPrice_;
        baseURI = baseURI_;
    }

    // ------------------------------------------------------------------ views

    function totalSupply() external view returns (uint256) {
        return pressed + artistProofsPressed;
    }

    function currentRun() public view returns (uint256) {
        return pressed / RUN_SIZE;
    }

    /// @notice Required leading zero bits: 16, rising one bit every two runs (to 20).
    function difficulty() public view returns (uint256) {
        return BASE_DIFFICULTY + currentRun() / 2;
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
        if (runStartedAt == 0) revert PressClosed();
        uint256 elapsed = block.timestamp - runStartedAt;
        uint256 premium = elapsed >= DECAY ? 0 : (floorPrice * (START_MULTIPLIER - 1) * (DECAY - elapsed)) / DECAY;
        premium = extraBits >= 256 ? 0 : premium >> extraBits;
        return floorPrice + premium;
    }

    function currentPrice() external view returns (uint256) {
        return priceFor(0);
    }

    // ------------------------------------------------------------------ press

    /// @notice Mint one print with a ground nonce. Overpayment is refunded.
    function press(uint256 nonce) external payable returns (uint256 tokenId) {
        if (runStartedAt == 0) revert PressClosed();
        if (pressed >= RUN_SIZE * RUNS) revert SoldOut();
        if (pressedBy[msg.sender] >= MAX_PER_WALLET) revert WalletLimitReached();

        bytes32 seed = proofHash(msg.sender, nonce);
        uint256 required = difficulty();
        uint256 bits = leadingZeroBits(seed);
        if (bits < required) revert InsufficientWork(bits, required);
        if (proofUsed[seed]) revert ProofAlreadyUsed();

        uint256 extraBits = bits - required;
        uint256 price = priceFor(extraBits);
        if (msg.value < price) revert Underpaid(price, msg.value);

        uint256 run = currentRun();
        proofUsed[seed] = true;
        pressedBy[msg.sender] += 1;
        pressed += 1;
        tokenId = ARTIST_PROOFS + pressed; // ids 1-3 are artist proofs
        seedOf[tokenId] = seed;
        difficultyOf[tokenId] = required;

        // Selling out a run re-inks the press: next run opens hot, one notch harder.
        if (pressed % RUN_SIZE == 0 && pressed < RUN_SIZE * RUNS) {
            runStartedAt = block.timestamp;
            emit RunStarted(currentRun(), difficulty(), block.timestamp);
        }

        emit Pressed(tokenId, msg.sender, seed, run, required, extraBits, price);
        _safeMint(msg.sender, tokenId);

        if (msg.value > price) {
            (bool ok,) = msg.sender.call{value: msg.value - price}("");
            if (!ok) revert TransferFailed();
        }
    }

    // ------------------------------------------------------------------ owner

    /// @notice Artist proofs still need work at the base difficulty, but are free.
    function pressArtistProof(uint256 nonce) external onlyOwner returns (uint256 tokenId) {
        if (artistProofsPressed >= ARTIST_PROOFS) revert SoldOut();
        bytes32 seed = proofHash(msg.sender, nonce);
        uint256 bits = leadingZeroBits(seed);
        if (bits < BASE_DIFFICULTY) revert InsufficientWork(bits, BASE_DIFFICULTY);
        if (proofUsed[seed]) revert ProofAlreadyUsed();
        proofUsed[seed] = true;
        artistProofsPressed += 1;
        tokenId = artistProofsPressed;
        seedOf[tokenId] = seed;
        difficultyOf[tokenId] = BASE_DIFFICULTY;
        emit Pressed(tokenId, msg.sender, seed, 0, BASE_DIFFICULTY, bits - BASE_DIFFICULTY, 0);
        _safeMint(msg.sender, tokenId);
    }

    function openPress() external onlyOwner {
        if (runStartedAt != 0) revert PressAlreadyOpen();
        runStartedAt = block.timestamp;
        emit PressOpened(floorPrice, block.timestamp);
        emit RunStarted(0, difficulty(), block.timestamp);
    }

    /// @notice The floor can only be set before the press opens, so buyers know it's fixed.
    function setFloorPrice(uint256 floorPrice_) external onlyOwner {
        if (runStartedAt != 0) revert PressAlreadyOpen();
        floorPrice = floorPrice_;
    }

    function setBaseURI(string calldata baseURI_) external onlyOwner {
        baseURI = baseURI_;
    }

    function withdraw(address payable to) external onlyOwner {
        (bool ok,) = to.call{value: address(this).balance}("");
        if (!ok) revert TransferFailed();
    }

    function _baseURI() internal view override returns (string memory) {
        return baseURI;
    }
}
