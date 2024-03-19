pragma circom 2.0.0;

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/bitify.circom";
include "merkleTree.circom";

template Withdraw(levels) {
    signal input root;
    signal input nullifierHash;
    signal input recipient; // not taking part in any computations
    signal input relayer;  // not taking part in any computations
    signal input fee;      // not taking part in any computations
    signal input nullifier;
    signal input pathElements[levels];
    signal input pathIndices[levels];

    component leafIndexNum = Bits2Num(levels);
    for (var i = 0; i < levels; i++) {
        leafIndexNum.in[i] <== pathIndices[i];
    }

    // leafIndexNum.out 作为 nullifierHasher 的第三个参数的作用
    // 是将梅克尔树中的叶子节点的索引（在这里是 pathIndices 数组对应
    // 的十进制数值）与 nullifier 和常数 1 进行混合。这样做的目的是
    // 确保每个提款请求的 nullifier 与其所在的叶子节点的索引相关联，
    // 从而增加了数据的安全性和完整性。
    // 
    //通过将 nullifier、常数 1 和 leafIndexNum.out 作为输入，
    // nullifierHasher 组件使用 Poseidon 哈希函数对这三个值
    // 进行混淆和计算，生成 nullifierHash。这个哈希值可以用于
    // 验证和检查提款请求的有效性，以及确保 nullifier 与相应的
    // 叶子节点索引相关联，从而保护系统免受恶意攻击和欺诈行为。
    component nullifierHasher = Poseidon(3);
    nullifierHasher.inputs[0] <== nullifier;
    nullifierHasher.inputs[1] <== 1;
    nullifierHasher.inputs[2] <== leafIndexNum.out;
    nullifierHasher.out === nullifierHash;

    component commitmentHasher = Poseidon(2);
    commitmentHasher.inputs[0] <== nullifier;
    commitmentHasher.inputs[1] <== 0;

    component tree = MerkleTreeChecker(levels);
    tree.leaf <== commitmentHasher.out;
    tree.root <== root;
    for (var i = 0; i < levels; i++) {
        tree.pathElements[i] <== pathElements[i];
        tree.pathIndices[i] <== pathIndices[i];
    }

    // Add hidden signals to make sure that tampering with recipient or fee will invalidate the snark proof
    // Most likely it is not required, but it's better to stay on the safe side and it only takes 2 constraints
    // Squares are used to prevent optimizer from removing those constraints
    signal recipientSquare;
    signal feeSquare;
    signal relayerSquare;
    recipientSquare <== recipient * recipient;
    feeSquare <== fee * fee;
    relayerSquare <== relayer * relayer;
}

component main {public [root,nullifierHash,recipient,relayer,fee]} = Withdraw(20);
