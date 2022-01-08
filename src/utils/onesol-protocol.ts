import bs58 from "bs58";
import { Buffer } from "buffer";
import * as BufferLayout from "buffer-layout";
import {
  Connection,
  Keypair,
  SystemProgram,
  SYSVAR_CLOCK_PUBKEY,
  TransactionSignature,
  SYSVAR_RENT_PUBKEY,
  Signer,
  AccountMeta,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TokenSwapLayout,
  StableSwapLayout,
  //SERUM_MARKET_LAYOUT_V2,
  //SERUM_OPEN_ORDERS_LAYOUT_V2,
} from "../models";
import {
  MintInfo as TokenMint,
  TOKEN_PROGRAM_ID,
  u64,
} from "@solana/spl-token";
import {
  publicKeyLayout,
  uint64,
} from './layout'
import {
  // SerumDexOpenOrders,
} from './serum'


export const ONESOL_PROTOCOL_PROGRAM_ID: PublicKey = new PublicKey(
  "1SoLTvbiicqXZ3MJmnTL2WYXKLYpuxwHpa4yYrVQaMZ"
);
export const RAYDIUM_PROGRAM_ID: PublicKey = new PublicKey(
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8'
);

export interface TokenMintInfo {
  pubkey: PublicKey;
  mintInfo: TokenMint;
}

export async function loadAccount(
  connection: Connection,
  address: PublicKey,
  programId: PublicKey
): Promise<Buffer> {
  const accountInfo = await connection.getAccountInfo(address);
  if (accountInfo === null) {
    throw new Error("Failed to find account");
  }

  if (!accountInfo.owner.equals(programId)) {
    throw new Error(`Invalid owner: ${JSON.stringify(accountInfo.owner.toBase58())}`);
  }

  return Buffer.from(accountInfo.data);
}

export enum AccountStatus {
  SwapInfo = 1,
  Closed = 3,
}

export const SwapInfoLayout = BufferLayout.struct([
  BufferLayout.u8("isInitialized"),
  BufferLayout.u8("status"),
  uint64("tokenLatestAmount"),
  publicKeyLayout("owner"),
  BufferLayout.u32("tokenAccountOption"),
  publicKeyLayout("tokenAccount")
]);


export interface SwapInfo {
  pubkey: PublicKey;
  programId: PublicKey;
  isInitialized: number;
  status: number;
  tokenLatestAmount: u64;
  owner: PublicKey;
  tokenAccount: PublicKey | null;
}

export class TokenSwapInfo {
  constructor(
    private programId: PublicKey,
    private swapInfo: PublicKey,
    private authority: PublicKey,
    private tokenAccountA: PublicKey,
    private tokenAccountB: PublicKey,
    private mintA: PublicKey,
    private mintB: PublicKey,
    private poolMint: PublicKey,
    private feeAccount: PublicKey,
  ) {
    this.programId = programId;
    this.swapInfo = swapInfo;
    this.authority = authority;
    this.tokenAccountA = tokenAccountA;
    this.tokenAccountB = tokenAccountB;
    this.mintA = mintA;
    this.mintB = mintB;
    this.poolMint = poolMint;
    this.feeAccount = feeAccount;
  }

  toKeys(): Array<AccountMeta> {
    const keys = [
      { pubkey: this.swapInfo, isSigner: false, isWritable: false },
      { pubkey: this.authority, isSigner: false, isWritable: false },
      { pubkey: this.tokenAccountA, isSigner: false, isWritable: true },
      { pubkey: this.tokenAccountB, isSigner: false, isWritable: true },
      { pubkey: this.poolMint, isSigner: false, isWritable: true },
      { pubkey: this.feeAccount, isSigner: false, isWritable: true },
      { pubkey: this.programId, isSigner: false, isWritable: false },
    ];
    return keys;
  }
}


export class SaberStableSwapInfo {
  constructor(
    private programId: PublicKey,
    private swapInfo: PublicKey,
    private authority: PublicKey,
    private tokenAccountA: PublicKey,
    private mintA: PublicKey,
    private adminFeeAccountA: PublicKey,
    private tokenAccountB: PublicKey,
    private mintB: PublicKey,
    private adminFeeAccountB: PublicKey,
  ) {
    this.programId = programId;
    this.swapInfo = swapInfo;
    this.authority = authority;
    this.tokenAccountA = tokenAccountA;
    this.tokenAccountB = tokenAccountB;
    this.adminFeeAccountA = adminFeeAccountA;
    this.adminFeeAccountB = adminFeeAccountB;
  }

  toKeys(sourceMint: PublicKey): Array<AccountMeta> {
    const keys = [
      { pubkey: this.swapInfo, isSigner: false, isWritable: false },
      { pubkey: this.authority, isSigner: false, isWritable: false },
      { pubkey: this.tokenAccountA, isSigner: false, isWritable: true },
      { pubkey: this.tokenAccountB, isSigner: false, isWritable: true },
    ];

    if (sourceMint.equals(this.mintA)) {
      keys.push(
        { pubkey: this.adminFeeAccountB, isSigner: false, isWritable: true },
      );
    } else {
      keys.push(
        { pubkey: this.adminFeeAccountA, isSigner: false, isWritable: true },
      );
    }
    keys.push(
      { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: this.programId, isSigner: false, isWritable: false },
    );
    return keys;
  }
}


/**
 * A program to exchange tokens against a pool of liquidity
 */
export class OneSolProtocol {

  private _openOrdersAccountsCache: {
    [key: string]: { pubkeys: PublicKey[]; ts: number };
  };

  /**
   * Create a Token object attached to the specific token
   *
   * @param connection The connection to use
   * @param protocolProgramID The program ID of the onesol-protocol program
   * @param swapProgramId The program ID of the token-swap program
   * @param tokenProgramId The program ID of the token program
   */
  constructor(
    private connection: Connection,
    public programId: PublicKey,
    public tokenProgramId: PublicKey,
    public wallet: PublicKey
  ) {
    this.connection = connection;
    this.programId = programId;
    this.tokenProgramId = tokenProgramId;
    this.wallet = wallet;
    this._openOrdersAccountsCache = {};
  }

  /**
   * findOneSolProtocol instance
   * @param connection
   * @param walletAddress
   * @param pcMintKey
   * @param coinMintKey
   * @param wallet
   * @param programId
   * @returns
   */
  static async createOneSolProtocol({
    connection,
    wallet,
    programId = ONESOL_PROTOCOL_PROGRAM_ID,
  }: {
    connection: Connection;
    wallet: PublicKey;
    programId?: PublicKey;
  }): Promise<OneSolProtocol> {
    return new OneSolProtocol(connection, programId, TOKEN_PROGRAM_ID, wallet);
  }

  async findSwapInfo({
    wallet,
  }: {
    wallet: PublicKey,
  }): Promise<SwapInfo | null> {
    const [accountItem] = await this.connection.getProgramAccounts(this.programId, {
      filters: [
        {
          dataSize: SwapInfoLayout.span,
        },
        {
          memcmp: {
            offset: SwapInfoLayout.offsetOf('isInitialized'),
            bytes: bs58.encode([1]),
          }
        },
        {
          memcmp: {
            offset: SwapInfoLayout.offsetOf('status'),
            bytes: bs58.encode([AccountStatus.SwapInfo]),
          }
        },
        {
          memcmp: {
            offset: SwapInfoLayout.offsetOf('owner'),
            bytes: wallet.toBase58(),
          },
        },
      ],
    });

    if (!accountItem) {
      return null
    }
    const { pubkey, account } = accountItem;
    const decoded: any = SwapInfoLayout.decode(account.data);
    const tokenAccount = decoded.tokenAccountOption === 0 ? null : new PublicKey(decoded.tokenAccount);
    return {
      pubkey,
      programId: account.owner,
      isInitialized: decoded.isInitialized,
      status: decoded.status,
      tokenLatestAmount: decoded.tokenLatestAmount,
      owner: new PublicKey(decoded.owner),
      tokenAccount,
    }
  }

  async createSwapInfo({
    instructions, signers, owner
  }: {
    owner: PublicKey;
    instructions: Array<TransactionInstruction>,
    signers: Array<Signer>,
  }) {
    const swapInfoAccount = Keypair.generate();
    const lamports = await this.connection.getMinimumBalanceForRentExemption(SwapInfoLayout.span);
    instructions.push(await SystemProgram.createAccount({
      fromPubkey: owner,
      newAccountPubkey: swapInfoAccount.publicKey,
      lamports: lamports,
      space: SwapInfoLayout.span,
      programId: this.programId,
    }));
    signers.push(swapInfoAccount);
    instructions.push(await OneSolProtocol.makeSwapInfoInstruction({
      swapInfo: swapInfoAccount.publicKey,
      owner,
      programId: this.programId,
    }));
    return swapInfoAccount.publicKey;
  }

  static async makeSwapInfoInstruction(
    { swapInfo, programId, owner }: {
      owner: PublicKey;
      swapInfo: PublicKey,
      programId: PublicKey,
    }): Promise<TransactionInstruction> {

    const dataLayout = BufferLayout.struct([
      BufferLayout.u8("instruction"),
    ]);
    const dataMap: any = {
      instruction: 10, // Swap instruction
    };
    const data = Buffer.alloc(dataLayout.span);
    dataLayout.encode(dataMap, data);

    const keys = [
      { pubkey: swapInfo, isSigner: true, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ];

    return new TransactionInstruction({
      keys,
      programId: programId,
      data,
    });
  }


  async setupSwapInfo(
    { swapInfo, tokenAccount, instructions, signers }: {
      swapInfo: PublicKey,
      tokenAccount: PublicKey,
      instructions: Array<TransactionInstruction>,
      signers: Array<Signer>,
    }
  ) {
    const keys = [
      { pubkey: swapInfo, isSigner: false, isWritable: true },
      { pubkey: tokenAccount, isSigner: false, isWritable: true },
    ];
    const dataLayout = BufferLayout.struct([
      BufferLayout.u8("instruction"),
    ]);
    const dataMap: any = {
      instruction: 11,
    };
    const data = Buffer.alloc(dataLayout.span);
    dataLayout.encode(dataMap, data);

    instructions.push(new TransactionInstruction({
      keys,
      programId: this.programId,
      data,
    }));
  }



  async createSwapBySaberStableSwapInstruction(
    {
      fromTokenAccountKey,
      toTokenAccountKey,
      fromMintKey,
      toMintKey,
      userTransferAuthority,
      feeTokenAccount,
      amountIn,
      expectAmountOut,
      minimumAmountOut,
      stableSwapInfo,
    }: {
      fromTokenAccountKey: PublicKey;
      toTokenAccountKey: PublicKey;
      fromMintKey: PublicKey;
      toMintKey: PublicKey;
      userTransferAuthority: PublicKey;
      feeTokenAccount: PublicKey;
      amountIn: u64;
      expectAmountOut: u64;
      minimumAmountOut: u64;
      stableSwapInfo: SaberStableSwapInfo;
    },
    instructions: Array<TransactionInstruction>,
    signers: Array<Signer>
  ): Promise<void> {
    instructions.push(
      await OneSolProtocol.makeSwapBySaberStableSwapInstruction({
        sourceTokenKey: fromTokenAccountKey,
        sourceMint: fromMintKey,
        destinationTokenKey: toTokenAccountKey,
        destinationMint: toMintKey,
        transferAuthority: userTransferAuthority,
        tokenProgramId: this.tokenProgramId,
        feeTokenAccount: feeTokenAccount,
        stableSwapInfo: stableSwapInfo,
        amountIn: amountIn,
        expectAmountOut: expectAmountOut,
        minimumAmountOut: minimumAmountOut,
        programId: this.programId,
      })
    );
  }

  static async makeSwapBySaberStableSwapInstruction({
    sourceTokenKey,
    sourceMint,
    destinationTokenKey,
    destinationMint,
    transferAuthority,
    tokenProgramId,
    feeTokenAccount,
    stableSwapInfo,
    amountIn,
    expectAmountOut,
    minimumAmountOut,
    programId = ONESOL_PROTOCOL_PROGRAM_ID,
  }: {
    sourceTokenKey: PublicKey;
    sourceMint: PublicKey;
    destinationTokenKey: PublicKey;
    destinationMint: PublicKey;
    transferAuthority: PublicKey;
    tokenProgramId: PublicKey;
    feeTokenAccount: PublicKey;
    stableSwapInfo: SaberStableSwapInfo;
    amountIn: u64;
    expectAmountOut: u64;
    minimumAmountOut: u64;
    programId?: PublicKey
  }): Promise<TransactionInstruction> {
    const dataLayout = BufferLayout.struct([
      BufferLayout.u8("instruction"),
      uint64("amountIn"),
      uint64("expectAmountOut"),
      uint64("minimumAmountOut"),
    ]);

    let dataMap: any = {
      instruction: 6, // Swap instruction
      amountIn: amountIn.toBuffer(),
      expectAmountOut: expectAmountOut.toBuffer(),
      minimumAmountOut: minimumAmountOut.toBuffer(),
    };

    const keys = [
      { pubkey: sourceTokenKey, isSigner: false, isWritable: true },
      { pubkey: destinationTokenKey, isSigner: false, isWritable: true },
      { pubkey: transferAuthority, isSigner: true, isWritable: false },
      { pubkey: tokenProgramId, isSigner: false, isWritable: false },
      { pubkey: feeTokenAccount, isSigner: false, isWritable: true }
    ];
    const swapKeys = stableSwapInfo.toKeys(sourceMint);
    keys.push(...swapKeys);

    const data = Buffer.alloc(dataLayout.span);
    dataLayout.encode(dataMap, data);

    return new TransactionInstruction({
      keys,
      programId: programId,
      data,
    });
  }

}

export function realSendAndConfirmTransaction(
  title: string,
  connection: Connection,
  transaction: Transaction,
  ...signers: Array<Signer>
): Promise<TransactionSignature> {
  return sendAndConfirmTransaction(connection, transaction, signers, {
    skipPreflight: false,
    commitment: "recent",
    preflightCommitment: "recent",
  });
}

export async function loadTokenSwapInfo(
  connection: Connection,
  address: PublicKey,
  programId: PublicKey,
  hostFeeAccount: PublicKey | null
): Promise<TokenSwapInfo> {
  const data = await loadAccount(connection, address, programId);
  const tokenSwapData: any = TokenSwapLayout.decode(data);

  if (!tokenSwapData.isInitialized) {
    throw new Error(`Invalid token swap state`);
  }

  const authority = await PublicKey.createProgramAddress(
    [address.toBuffer()].concat(Buffer.from([tokenSwapData.nonce])),
    programId
  );

  const poolMint = new PublicKey(tokenSwapData.tokenPool);
  const feeAccount = new PublicKey(tokenSwapData.feeAccount);
  const tokenAccountA = new PublicKey(tokenSwapData.tokenAccountA);
  const mintA = new PublicKey(tokenSwapData.mintA);
  const tokenAccountB = new PublicKey(tokenSwapData.tokenAccountB);
  const mintB = new PublicKey(tokenSwapData.mintB);

  return new TokenSwapInfo(
    programId,
    address,
    authority,
    tokenAccountA,
    tokenAccountB,
    mintA,
    mintB,
    poolMint,
    feeAccount,
  );
}


export async function loadSaberStableSwap(
  {
    connection,
    address,
    programId,
  }: {
    connection: Connection;
    address: PublicKey,
    programId: PublicKey,
  }
): Promise<SaberStableSwapInfo> {
  console.log("onesol-protocol.ts > loadSaberStableSwap", loadSaberStableSwap)

  const data = await loadAccount(connection, address, programId);
  const stableSwapData: any = StableSwapLayout.decode(data);

  if (!stableSwapData.isInitialized || stableSwapData.isPaused) {
    throw new Error(`Invalid token swap state`);
  }

  const authority = await PublicKey.createProgramAddress(
    [address.toBuffer()].concat(Buffer.from([stableSwapData.nonce])),
    programId
  );

  const tokenAccountA = new PublicKey(stableSwapData.tokenAccountA);
  const mintA = new PublicKey(stableSwapData.mintA);
  const adminFeeAccountA = new PublicKey(stableSwapData.adminFeeAccountA);
  const tokenAccountB = new PublicKey(stableSwapData.tokenAccountB);
  const mintB = new PublicKey(stableSwapData.mintB);
  const adminFeeAccountB = new PublicKey(stableSwapData.adminFeeAccountB);

  return new SaberStableSwapInfo(
    programId,
    address,
    authority,
    tokenAccountA,
    mintA,
    adminFeeAccountA,
    tokenAccountB,
    mintB,
    adminFeeAccountB
  );
}
