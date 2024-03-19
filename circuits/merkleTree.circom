pragma circom 2.0.0;

include "../node_modules/circomlib/circuits/poseidon.circom";


// if s == 0 returns [in[0], in[1]]
// if s == 1 returns [in[1], in[0]]
template DualMux() {
    signal input in[2];
    signal input s;
    signal output out[2];

    s * (1 - s) === 0;
    out[0] <== (in[1] - in[0])*s + in[0];
    out[1] <== (in[0] - in[1])*s + in[1];
}

// Verifies that merkle proof is correct for given merkle root and a leaf
// pathIndices input is an array of 0/1 selectors telling whether given pathElement is on the left or right side of merkle path
template MerkleTreeChecker(levels) {
    signal input leaf;
    signal input root;
    signal input pathElements[levels];
    signal input pathIndices[levels];

    component selectors[levels];
    component hashers[levels];

    // 根据传入的 wintess 可以构造出从 leaf -> root 的
    // Merkel Tree 路径
    for (var i = 0; i < levels; i++) {
        selectors[i] = DualMux();
        selectors[i].in[0] <== i == 0 ? leaf : hashers[i - 1].out;
        selectors[i].in[1] <== pathElements[i]; // leaf 或者 node
        selectors[i].s <== pathIndices[i]; // leaft 或者 node 的 sibling 节点

        hashers[i] = Poseidon(2);
        // 输入两个节点, 输出 hash 节点
        hashers[i].inputs[0] <== selectors[i].out[0]; 
        hashers[i].inputs[1] <== selectors[i].out[1];
    }

    // 验证 root 是否正确
    root === hashers[levels - 1].out;
}
