import { assert, expect } from "chai";
import { ETHTornado__factory, Verifier__factory, ETHTornado } from "../types/";

import { ethers } from "hardhat";
import { Contract, ContractFactory, BigNumber, BigNumberish } from "ethers";
// @ts-ignore
import { poseidonContract, buildPoseidon } from "circomlibjs";
// @ts-ignore
import { MerkleTree, Hasher } from "../src/merkleTree";
// @ts-ignore
import { groth16 } from "snarkjs";
import path from "path";

const ETH_AMOUNT = ethers.utils.parseEther("1");
const HEIGHT = 20;

// poseidon 是一个 zkp 函数，这个函数根据 inputs 计算 poseidon hash
// 并将十六进制字符串填充为 32 字节长度 (64 个十六进制字符)。这样做是为了
// 与以太坊智能合约中的 bytes32 类型兼容,因为在以太坊中,哈希值通常被表示为 32 字节的十六进制字符串。
function poseidonHash(poseidon: any, inputs: BigNumberish[]): string {
    const hash = poseidon(inputs.map((x) => BigNumber.from(x).toBigInt()));
    // Make the number within the field size
    const hashStr = poseidon.F.toString(hash);
    // Make it a valid hex string
    const hashHex = BigNumber.from(hashStr).toHexString();
    // pad zero to make it 32 bytes, so that the output can be taken as a bytes32 contract argument
    const bytes32 = ethers.utils.hexZeroPad(hashHex, 32);
    return bytes32;
}

class PoseidonHasher implements Hasher {
    poseidon: any;

    constructor(poseidon: any) {
        this.poseidon = poseidon;
    }

    hash(left: string, right: string) {
        return poseidonHash(this.poseidon, [left, right]);
    }
}

class Deposit {
    private constructor(
        public readonly nullifier: Uint8Array,
        public poseidon: any,
        public leafIndex?: number
    ) {
        this.poseidon = poseidon;
    }
    static new(poseidon: any) {
        const nullifier = ethers.utils.randomBytes(15);
        return new this(nullifier, poseidon);
    }

    // commitment 是包含了 nullifier 的 hash
    get commitment() {
        return poseidonHash(this.poseidon, [this.nullifier, 0]);
    }

    get nullifierHash() {
        if (!this.leafIndex && this.leafIndex !== 0)
            throw Error("leafIndex is unset yet");
        return poseidonHash(this.poseidon, [this.nullifier, 1, this.leafIndex]);
    }
}

function getPoseidonFactory(nInputs: number) {
    // 创建 contract bytecode
    // https://github.com/iden3/circomlibjs/blob/4f094c5be05c1f0210924a3ab204d8fd8da69f49/src/poseidon_gencontract.js#L23
    const bytecode = poseidonContract.createCode(nInputs);
    // 输出 contract abi json
    // https://github.com/iden3/circomlibjs/blob/4f094c5be05c1f0210924a3ab204d8fd8da69f49/src/poseidon_gencontract.js#L161
    const abiJson = poseidonContract.generateABI(nInputs);
    const abi = new ethers.utils.Interface(abiJson);
    return new ContractFactory(abi, bytecode);
}

interface Proof {
    a: [BigNumberish, BigNumberish];
    b: [[BigNumberish, BigNumberish], [BigNumberish, BigNumberish]];
    c: [BigNumberish, BigNumberish];
}

async function prove(witness: any): Promise<Proof> {
    const wasmPath = path.join(__dirname, "../build/withdraw_js/withdraw.wasm");
    const zkeyPath = path.join(__dirname, "../build/circuit_final.zkey");

    // snarkjs 对于 groth16.prove 返回 {proof, publicSingnals},
    // proof 结构定义为
    // let proof: {
    // pi_a: any;
    // Pi_b: any;
    // Pi_c: any;
    // Protocol: string;
    // Curve: any;
    // }
    const { proof } = await groth16.fullProve(witness, wasmPath, zkeyPath);
    const solProof: Proof = {
        a: [proof.pi_a[0], proof.pi_a[1]],
        b: [
            [proof.pi_b[0][1], proof.pi_b[0][0]],
            [proof.pi_b[1][1], proof.pi_b[1][0]],
        ],
        c: [proof.pi_c[0], proof.pi_c[1]],
    };
    return solProof;
}

describe("ETHTornado", function () {
    let tornado: ETHTornado;
    let poseidon: any;
    let poseidonContract: Contract;

    before(async () => {
        poseidon = await buildPoseidon();
    });

    beforeEach(async function () {
        const [signer] = await ethers.getSigners();
        const verifier = await new Verifier__factory(signer).deploy();
        // 部署一个 poseidon 合约，这个合约用在链上的 Tornado 
        // 在生成 merkel tree 时的 hasher 函数.
        poseidonContract = await getPoseidonFactory(2).connect(signer).deploy();
        tornado = await new ETHTornado__factory(signer).deploy(
            verifier.address,
            ETH_AMOUNT,
            HEIGHT,
            poseidonContract.address
        );
    });

    it("generates same poseidon hash", async function () {
        const res = await poseidonContract["poseidon(uint256[2])"]([1, 2]);
        const res2 = poseidon([1, 2]);

        assert.equal(res.toString(), poseidon.F.toString(res2));
    }).timeout(500000);

    it("deposit and withdraw", async function () {
        const [userOldSigner, relayerSigner, userNewSigner] =
            await ethers.getSigners();
        const deposit = Deposit.new(poseidon);

        // commitment 是一个 zkp
        const tx = await tornado
            .connect(userOldSigner)
            .deposit(deposit.commitment, { value: ETH_AMOUNT });
        const receipt = await tx.wait();
        const events = await tornado.queryFilter(
            tornado.filters.Deposit(),
            receipt.blockHash
        );
        assert.equal(events[0].args.commitment, deposit.commitment);
        console.log("Deposit gas cost", receipt.gasUsed.toNumber());
        // deposit 合约将 commitment 插入 MerkelTree 后返回一个 index
        deposit.leafIndex = events[0].args.leafIndex;

        const tree = new MerkleTree(
            HEIGHT,
            "test",
            new PoseidonHasher(poseidon)
        );
        // 这里应该相等, 链上也使用的 poseidon  hash
        assert.equal(await tree.root(), await tornado.roots(0));
        await tree.insert(deposit.commitment);
        // 链上在存款的时候也插入了 commitment
        assert.equal(tree.totalElements, await tornado.nextIndex());
        assert.equal(await tree.root(), await tornado.roots(1));

        // 随机字符串 + 链上 commitment 的 index 计算 nullifierHash
        const nullifierHash = deposit.nullifierHash;
        const recipient = await userNewSigner.getAddress();
        const relayer = await relayerSigner.getAddress();
        const fee = 0;

        const { root, path_elements, path_index } = await tree.path(
            deposit.leafIndex
        );

        const witness = {
            // Public
            root,
            nullifierHash,
            recipient, // 接受eth账户地址，即 user
            relayer, // tornado 中继地址
            fee,
            // Private
            nullifier: BigNumber.from(deposit.nullifier).toBigInt(), // 随机的byte
            pathElements: path_elements,
            pathIndices: path_index,
        };

        // 首先存在一个 withdraw 的电路，这个电路已经编译好了，并且最大
        // 支持 20 层的 merkel tree，当 prove 时，根据 deposit.leafIndex 找到
        // path_elements, path_index, 然后作为电路的输入，然后生成一个证明。
        const solProof = await prove(witness);

        const txWithdraw = await tornado
            .connect(relayerSigner)
            .withdraw(solProof, root, nullifierHash, recipient, relayer, fee);
        const receiptWithdraw = await txWithdraw.wait();
        console.log("Withdraw gas cost", receiptWithdraw.gasUsed.toNumber());
    }).timeout(500000);

    it("prevent a user withdrawing twice", async function () {
        const [userOldSigner, relayerSigner, userNewSigner] =
            await ethers.getSigners();
        const deposit = Deposit.new(poseidon);
        const tx = await tornado
            .connect(userOldSigner)
            .deposit(deposit.commitment, { value: ETH_AMOUNT });
        const receipt = await tx.wait();
        const events = await tornado.queryFilter(
            tornado.filters.Deposit(),
            receipt.blockHash
        );
        deposit.leafIndex = events[0].args.leafIndex;

        const tree = new MerkleTree(
            HEIGHT,
            "test",
            new PoseidonHasher(poseidon)
        );
        await tree.insert(deposit.commitment);

        const nullifierHash = deposit.nullifierHash;
        const recipient = await userNewSigner.getAddress();
        const relayer = await relayerSigner.getAddress();
        const fee = 0;

        const { root, path_elements, path_index } = await tree.path(
            deposit.leafIndex
        );

        const witness = {
            // Public
            root,
            nullifierHash,
            recipient,
            relayer,
            fee,
            // Private
            nullifier: BigNumber.from(deposit.nullifier).toBigInt(),
            pathElements: path_elements,
            pathIndices: path_index,
        };

        const solProof = await prove(witness);

        // First withdraw
        await tornado
            .connect(relayerSigner)
            .withdraw(solProof, root, nullifierHash, recipient, relayer, fee);

        // Second withdraw
        // 因为 Tornado 合约中会使用 nullifier 会过滤，所以失败
        await tornado
            .connect(relayerSigner)
            .withdraw(solProof, root, nullifierHash, recipient, relayer, fee)
            .then(
                () => {
                    assert.fail("Expect tx to fail");
                },
                (error) => {
                    expect(error.message).to.have.string(
                        "The note has been already spent"
                    );
                }
            );
    }).timeout(500000);
    it("prevent a user withdrawing from a non-existent root", async function () {
        const [honestUser, relayerSigner, attacker] = await ethers.getSigners();

        // An honest user makes a deposit
        // the point here is just to top up some balance in the tornado contract
        const depositHonest = Deposit.new(poseidon);
        const tx = await tornado
            .connect(honestUser)
            .deposit(depositHonest.commitment, { value: ETH_AMOUNT });
        const receipt = await tx.wait();
        const events = await tornado.queryFilter(
            tornado.filters.Deposit(),
            receipt.blockHash
        );
        depositHonest.leafIndex = events[0].args.leafIndex;

        // The attacker never made a deposit on chain
        const depositAttacker = Deposit.new(poseidon);
        depositAttacker.leafIndex = 1;

        // The attacker constructed a tree which includes their deposit
        const tree = new MerkleTree(
            HEIGHT,
            "test",
            new PoseidonHasher(poseidon)
        );
        await tree.insert(depositHonest.commitment);
        await tree.insert(depositAttacker.commitment);

        const nullifierHash = depositAttacker.nullifierHash;
        const recipient = await attacker.getAddress();
        const relayer = await relayerSigner.getAddress();
        const fee = 0;

        // Attacker construct the proof
        const { root, path_elements, path_index } = await tree.path(
            depositAttacker.leafIndex
        );

        const witness = {
            // Public
            root,
            nullifierHash,
            recipient,
            relayer,
            fee,
            // Private
            nullifier: BigNumber.from(depositAttacker.nullifier).toBigInt(),
            pathElements: path_elements,
            pathIndices: path_index,
        };

        const solProof = await prove(witness);

        await tornado
            .connect(relayerSigner)
            .withdraw(solProof, root, nullifierHash, recipient, relayer, fee)
            .then(
                () => {
                    assert.fail("Expect tx to fail");
                },
                (error) => {
                    expect(error.message).to.have.string(
                        "Cannot find your merkle root"
                    );
                }
            );
    }).timeout(500000);
});
