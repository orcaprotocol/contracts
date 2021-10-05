const { expect, use } = require("chai");
const { waffle, ethers, deployments } = require("hardhat");
const { labelhash } = require("@ensdomains/ensjs");

const EthersSafe = require("@gnosis.pm/safe-core-sdk").default;

const GnosisSafe = require("@gnosis.pm/safe-contracts/build/artifacts/contracts/GnosisSafe.sol/GnosisSafe.json");
const MultiSend = require("@gnosis.pm/safe-contracts/build/artifacts/contracts/libraries/MultiSend.sol/MultiSend.json");

const { deployContract, provider, solidity } = waffle;

use(solidity);

describe("Controller safe integration test", () => {
  const [admin, alice, bob, charlie] = provider.getWallets();

  let multiSend;
  let controller;

  const { HashZero, AddressZero } = ethers.constants;

  const TX_OPTIONS = { gasLimit: 4000000 };

  const THRESHOLD = 1;
  const MEMBERS = [alice.address, bob.address];
  const POD_ID = 0;

  const createSafeSigner = async (safe, signer) => {
    const { chainId } = await provider.getNetwork();

    return EthersSafe.create({
      ethers,
      safeAddress: safe.address,
      providerOrSigner: signer,
      contractNetworks: {
        [chainId]: {
          multiSendAddress: multiSend.address,
        },
      },
    });
  };

  const createPodSafe = async (adminAddress, podId, label, ensString) => {
    await controller.connect(admin).createPod(MEMBERS, THRESHOLD, adminAddress, label, ensString, TX_OPTIONS);
    // query the new gnosis safe
    const safeAddress = await controller.podIdToSafe(podId);
    return new ethers.Contract(safeAddress, GnosisSafe.abi, admin);
  };

  const setup = async () => {
    await deployments.fixture(["Base"]);
    // Deploy the master safe contract and multisend
    multiSend = await deployContract(admin, MultiSend);

    controller = await ethers.getContract("Controller", admin);

    const memberToken = await ethers.getContract("MemberToken", admin);
    const gnosisSafeProxyFactory = await ethers.getContract("GnosisSafeProxyFactory", admin);
    const gnosisSafeMaster = await ethers.getContract("GnosisSafe", admin);

    const podSafe = await createPodSafe(admin.address, POD_ID, labelhash("test"), "test.pod.xyz");
    const ethersSafe = await createSafeSigner(podSafe, admin);

    return { memberToken, ethersSafe, gnosisSafeProxyFactory, gnosisSafeMaster };
  };

  describe("when creating new pod with safe deployment", () => {
    it("should create a new safe with safe teller module", async () => {
      const { ethersSafe } = await setup();

      // threshold and owners
      expect(await ethersSafe.getThreshold()).to.equal(THRESHOLD);
      expect(await ethersSafe.getOwners()).to.deep.equal(MEMBERS);
      // check to see if module has been enabled
      expect(await ethersSafe.isModuleEnabled(controller.address)).to.equal(true);
    });

    it("should distribute member tokens and set admin", async () => {
      const { memberToken } = await setup();

      // should set admin
      expect(await controller.podAdmin(POD_ID)).to.equal(admin.address);
      // should mint member tokens
      expect(await memberToken.balanceOf(alice.address, POD_ID)).to.equal(1);
      expect(await memberToken.balanceOf(bob.address, POD_ID)).to.equal(1);
    });
  });

  describe("when creating new pod with existing safe", () => {
    it("should create a new safe with safe teller module", async () => {
      const { memberToken, gnosisSafeProxyFactory, gnosisSafeMaster } = await setup();

      const safeAddress = await gnosisSafeProxyFactory.callStatic.createProxy(gnosisSafeMaster.address, HashZero);
      await gnosisSafeProxyFactory.createProxy(gnosisSafeMaster.address, HashZero);
      const safe = gnosisSafeMaster.attach(safeAddress);

      await safe.setup(MEMBERS, 1, AddressZero, HashZero, AddressZero, AddressZero, 0, AddressZero);

      const txArgs = {
        to: safe.address,
        data: safe.interface.encodeFunctionData("enableModule", [controller.address]),
        value: 0,
      };

      const safeSignerAlice = await createSafeSigner(safe, alice);
      const tx = await safeSignerAlice.createTransaction(txArgs);
      await safeSignerAlice.executeTransaction(tx);

      await controller
        .connect(alice)
        .createPodWithSafe(admin.address, safe.address, labelhash("test2"), "test2.pod.xyz");

      // should set admin
      expect(await controller.podAdmin(POD_ID + 1)).to.equal(admin.address);
      // should mint member tokens
      expect(await memberToken.balanceOf(alice.address, POD_ID + 1)).to.equal(1);
      expect(await memberToken.balanceOf(bob.address, POD_ID + 1)).to.equal(1);

      // should throw on subsequent create
      await expect(
        controller.connect(alice).createPodWithSafe(admin.address, safe.address, labelhash("test2"), "test2.pod.xyz"),
      ).to.be.revertedWith("safe already in use");
    });
  });

  describe("when a pod has an admin", () => {
    it("should let admin set new admin", async () => {
      await setup();

      await controller.updatePodAdmin(POD_ID, alice.address);
      expect(await controller.podAdmin(POD_ID)).to.equal(alice.address);
    });
    it("should throw if safe updates admin", async () => {
      const { ethersSafe } = await setup();

      const txArgs = {
        to: controller.address,
        data: controller.interface.encodeFunctionData("updatePodAdmin", [POD_ID, alice.address]),
        value: 0,
      };

      await expect(ethersSafe.createTransaction(txArgs)).to.be.revertedWith("Only admin can update admin");
    });
  });

  describe("when a pod has no admin", () => {
    it("should throw if member updates admin", async () => {
      await setup();
      await createPodSafe(AddressZero, POD_ID + 1, labelhash("test2"), "test2.pod.xyz");

      await expect(controller.connect(alice).updatePodAdmin(POD_ID + 1, alice.address)).to.be.revertedWith(
        "Only safe can add new admin",
      );
    });
    it("should let safe update admin", async () => {
      await setup();
      const podSafe = await createPodSafe(AddressZero, POD_ID + 1, labelhash("test2"), "test2.pod.xyz");
      const ethersSafe = await createSafeSigner(podSafe, alice);

      const txArgs = {
        to: controller.address,
        data: controller.interface.encodeFunctionData("updatePodAdmin", [POD_ID + 1, alice.address]),
        value: 0,
      };
      const tx = await ethersSafe.createTransaction(txArgs);
      await ethersSafe.executeTransaction(tx);

      expect(await controller.podAdmin(POD_ID + 1)).to.equal(alice.address);
    });
  });

  describe("when a pod has an admin", () => {
    it("should let admin set new admin", async () => {
      await setup();

      await controller.updatePodAdmin(POD_ID, alice.address);
      expect(await controller.podAdmin(POD_ID)).to.equal(alice.address);
    });
    it("should throw if safe updates admin", async () => {
      const { ethersSafe } = await setup();

      const txArgs = {
        to: controller.address,
        data: controller.interface.encodeFunctionData("updatePodAdmin", [POD_ID, alice.address]),
        value: 0,
      };

      await expect(ethersSafe.createTransaction(txArgs)).to.be.revertedWith("Only admin can update admin");
    });
  });

  describe("when a pod has no admin", () => {
    it("should throw if member updates admin", async () => {
      await setup();
      await createPodSafe(AddressZero, POD_ID + 1);

      await expect(controller.connect(alice).updatePodAdmin(POD_ID + 1, alice.address)).to.be.revertedWith(
        "Only safe can add new admin",
      );
    });
    it("should let safe update admin", async () => {
      await setup();
      const podSafe = await createPodSafe(AddressZero, POD_ID + 1);
      const ethersSafe = await createSafeSigner(podSafe, alice);

      const txArgs = {
        to: controller.address,
        data: controller.interface.encodeFunctionData("updatePodAdmin", [POD_ID + 1, alice.address]),
        value: 0,
      };
      const tx = await ethersSafe.createTransaction(txArgs);
      await ethersSafe.executeTransaction(tx);

      expect(await controller.podAdmin(POD_ID + 1)).to.equal(alice.address);
    });
  });

  describe("managing pod owners with membership NFTs", () => {
    let memberToken;
    let ethersSafe;

    beforeEach(async () => {
      ({ memberToken, ethersSafe } = await setup());
    });

  describe("when managing pod owners with membership NFTs", () => {
    it("should be able to transfer memberships", async () => {
      const { memberToken, ethersSafe } = await setup();

      await memberToken
        .connect(alice)
        .safeTransferFrom(alice.address, charlie.address, POD_ID, 1, HashZero, TX_OPTIONS);
      // check token balance
      expect(await memberToken.balanceOf(alice.address, POD_ID)).to.equal(0);
      expect(await memberToken.balanceOf(charlie.address, POD_ID)).to.equal(1);
      // check safe owners
      expect(await ethersSafe.getOwners()).to.deep.equal([charlie.address, bob.address]);
    });

    it("should be able to burn memberships", async () => {
      const { memberToken, ethersSafe } = await setup();

      await memberToken.connect(admin).burn(alice.address, POD_ID, TX_OPTIONS);
      // check token balance
      expect(await memberToken.balanceOf(alice.address, POD_ID)).to.equal(0);
      // check safe owners
      expect(await ethersSafe.getOwners()).to.deep.equal([bob.address]);
    });

    it("should be able to mint memberships", async () => {
      const { memberToken, ethersSafe } = await setup();

      await memberToken.connect(admin).mint(charlie.address, POD_ID, HashZero);
      // check token balance
      expect(await memberToken.balanceOf(charlie.address, POD_ID)).to.equal(1);
      // check safe owners
      expect(await ethersSafe.getOwners()).to.deep.equal([charlie.address, alice.address, bob.address]);
    });
  });
});
