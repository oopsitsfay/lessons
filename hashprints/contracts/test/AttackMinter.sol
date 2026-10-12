// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

interface IHashPrints {
    function press(uint256 nonce) external payable returns (uint256);
}

/// @dev Test-only: a contract minter that re-enters `press` from the ERC-721 callback
///      and can refuse the overpayment refund.
contract AttackMinter is IERC721Receiver {
    IHashPrints public immutable target;
    uint256[] private nonces;
    uint256 private next;
    uint256 private perPress;
    bool private rejectRefunds;

    constructor(IHashPrints target_) {
        target = target_;
    }

    function go(uint256[] calldata nonces_, uint256 perPress_, bool rejectRefunds_) external payable {
        nonces = nonces_;
        perPress = perPress_;
        rejectRefunds = rejectRefunds_;
        next = 1;
        target.press{value: perPress_}(nonces_[0]);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4) {
        if (next < nonces.length) {
            uint256 k = next++;
            target.press{value: perPress}(nonces[k]);
        }
        return IERC721Receiver.onERC721Received.selector;
    }

    receive() external payable {
        if (rejectRefunds) revert("no refunds");
    }
}
