import assert from 'assert';
import BN from 'bn.js';
import {Buffer} from 'buffer';
import * as BufferLayout from 'buffer-layout';
import type {Connection,  TransactionSignature} from '@solana/web3.js';

import {
  Account,
  AccountMeta,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';

import * as Layout from './layout';
import { deserialize } from 'v8';

export const ONESOL_PROTOCOL_PROGRAM_ID: PublicKey = new PublicKey(
  '26XgL6X46AHxcMkfDNfnfQHrqZGzYEcTLj9SmAV5dLrV',
);

/**
 * Some amount of tokens
 */
export class Numberu64 extends BN {
  /**
   * Convert to Buffer representation
   */
  toBuffer(): Buffer {
    const a = super.toArray().reverse();
    const b = Buffer.from(a);
    if (b.length === 8) {
      return b;
    }
    assert(b.length < 8, 'Numberu64 too large');

    const zeroPad = Buffer.alloc(8);
    b.copy(zeroPad);
    return zeroPad;
  }

  /**
   * Construct a Numberu64 from Buffer representation
   */
  static fromBuffer(buffer: Buffer): Numberu64 {
    assert(buffer.length === 8, `Invalid buffer length: ${buffer.length}`);
    return new Numberu64(
      [...buffer]
        .reverse()
        .map(i => `00${i.toString(16)}`.slice(-2))
        .join(''),
      16,
    );
  }
}

export async function loadAccount(
  connection: Connection,
  address: PublicKey,
  programId: PublicKey,
): Promise<Buffer> {
  const accountInfo = await connection.getAccountInfo(address);
  if (accountInfo === null) {
    throw new Error('Failed to find account');
  }

  if (!accountInfo.owner.equals(programId)) {
    throw new Error(`Invalid owner: ${JSON.stringify(accountInfo.owner)}`);
  }

  return Buffer.from(accountInfo.data);
}

export const OneSolProtocolLayout = BufferLayout.struct([
  BufferLayout.u8('version'),
  BufferLayout.u8('nonce'),
  Layout.publicKey('tokenProgramId'),
  Layout.publicKey('tokenAccount'),
  Layout.publicKey('mint'),
]);

export class TokenSwapInfo {
  constructor(
    private programId: PublicKey,
    private swapInfo: PublicKey,
    private authority: PublicKey,
    private poolSource: PublicKey,
    private poolDestination: PublicKey,
    private poolMint: PublicKey,
    private poolFeeAccount: PublicKey,
    private hostFeeAccount: PublicKey | null,
  ) {
    this.programId = programId;
    this.swapInfo = swapInfo;
    this.authority = authority;
    this.poolSource = poolSource;
    this.poolDestination = poolDestination;
    this.poolMint = poolMint;
    this.poolFeeAccount = poolFeeAccount;
    this.hostFeeAccount = hostFeeAccount;
  }

  toKeys(): Array<AccountMeta>{
    const keys = [
      {pubkey: this.swapInfo, isSigner: false, isWritable: false},
      {pubkey: this.authority, isSigner: false, isWritable: false},
      {pubkey: this.poolSource, isSigner: false, isWritable: true},
      {pubkey: this.poolDestination, isSigner: false, isWritable: true},
      {pubkey: this.poolMint, isSigner: false, isWritable: true},
      {pubkey: this.poolFeeAccount, isSigner: false, isWritable: true},
      {pubkey: this.programId, isSigner: false, isWritable: false},
    ];
    if (this.hostFeeAccount !== null) {
      keys.push({pubkey: this.hostFeeAccount, isSigner: false, isWritable: true});
    }
    return keys;
  }

  includeHostFeeAccount(): number {
    if (this.hostFeeAccount !== null) {
      return 1
    } else {
      return 0
    }
  }
}

/**
 * A program to exchange tokens against a pool of liquidity
 */
export class OneSolProtocol{
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
    public protocolInfo: PublicKey,
    public protocolProgramId: PublicKey,
    public tokenProgramId: PublicKey,
    public tokenAccountKey: PublicKey,
    public authority: PublicKey,
    public nonce: number,
    public payer: Account,
  ) {
    this.connection = connection;
    this.protocolInfo = protocolInfo;
    this.protocolProgramId = protocolProgramId;
    this.tokenProgramId = tokenProgramId;
    this.tokenAccountKey = tokenAccountKey;
    this.nonce = nonce;
    this.payer = payer;
  }

  static async loadOneSolProtocol(
    connection: Connection,
    address: PublicKey,
    programId: PublicKey,
    payer: Account,
  ): Promise<OneSolProtocol> {
    const data = await loadAccount(connection, address, programId);
    const onesolProtocolData = OneSolProtocolLayout.decode(data);
    if (onesolProtocolData.version != 1) {
      throw new Error(`Invalid OneSolProtocol data`);
    }
    const [authority] = await PublicKey.findProgramAddress(
      [address.toBuffer()],
      programId,
    )

    return new OneSolProtocol(
      connection,
      address,
      programId,
      new PublicKey(onesolProtocolData.tokenProgramId),
      new PublicKey(onesolProtocolData.tokenAccount),
      authority,
      onesolProtocolData.nonce,
      payer,
    )

  }

  /**
   * Create a new OneSol Swap
   *
   * @param connection The connection to use
   * @param protocolAccountInfo The onesolProtocol account pubkey to use
   * @param tokenAccountKey The onesolProtocol token account pubkey to use
   * @param tokenProgramId The program ID of the token program
   * @param authority the authority over the swap and accounts
   * @param nonce The nonce used to generate the authority
   * @param payer the payer
   * @param protocolProgramID The  program ID of the onesolProtocol program
   * @return Token object for the newly minted token, Public key of the account holding the total supply of new tokens
   */
  static async createOneSolProtocol(
    connection: Connection,
    protocolAccountInfo: Account,
    tokenAccountKey: PublicKey,
    tokenProgramId: PublicKey,
    authority: PublicKey,
    nonce: number, 
    payer: Account,
    protocolProgramId: PublicKey,
  ): Promise<OneSolProtocol> {
    // let transaction;
    const onesolSwap = new OneSolProtocol(
      connection,
      protocolAccountInfo.publicKey,
      protocolProgramId,
      tokenProgramId,
      tokenAccountKey,
      authority,
      nonce,
      payer,
    );

    // Allocate memory for the account
    const balanceNeeded = await OneSolProtocol.getMinBalanceRentForExemptTokenSwap(
      connection,
    );
    // console.log("balanceNeeded: " + balanceNeeded);
    // console.log("create onesolProgram account.");
    let transaction = new Transaction();
    transaction.add(
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: protocolAccountInfo.publicKey,
        lamports: balanceNeeded,
        space: OneSolProtocolLayout.span,
        programId: protocolProgramId,
      }),
    );
    const instruction = OneSolProtocol.createInitSwapInstruction(
      protocolAccountInfo,
      authority,
      tokenAccountKey,
      protocolProgramId,
      tokenProgramId,
      nonce,
    );

    transaction.add(instruction);
    await realSendAndConfirmTransaction(
      'createAccount and InitializeSwap',
      connection,
      transaction,
      payer,
      protocolAccountInfo,
    );
    return onesolSwap;
  }

  /**
   Get the minimum balance for the token swap account to be rent exempt
  
   @return Number of lamports required
  **/
  static async getMinBalanceRentForExemptTokenSwap(
    connection: Connection,
  ): Promise<number> {
    return await connection.getMinimumBalanceForRentExemption(
      OneSolProtocolLayout.span,
    );
  }

  static createInitSwapInstruction(
    onesolProtocolAccount: Account,
    authority: PublicKey,
    tokenAccount: PublicKey,
    protocolProgramId: PublicKey,
    tokenProgramId: PublicKey,
    nonce: number,
  ): TransactionInstruction {
    const keys = [
      {pubkey: onesolProtocolAccount.publicKey, isSigner: false, isWritable: true},
      {pubkey: authority, isSigner: false, isWritable: false},
      {pubkey: tokenAccount, isSigner: false, isWritable: false},
      {pubkey: tokenProgramId, isSigner: false, isWritable: false},
    ];
    const commandDataLayout = BufferLayout.struct([
      BufferLayout.u8('instruction'),
      BufferLayout.u8('nonce'),
    ]);
    let data = Buffer.alloc(1024);
    {
      const encodeLength = commandDataLayout.encode({
        instruction: 0,
        nonce,
      }, data);
      data = data.slice(0, encodeLength);
    }
    return new TransactionInstruction({
      keys,
      programId: protocolProgramId,
      data,
    })
  }

  /**
   * Swap token A for token B
   *
   * @param userTransferAuthority Account delegated to transfer user's tokens
   * @param userSource User's source token account
   * @param userDestination User's destination token account
   * @param amountIn Amount to transfer from source account
   * @param minimumAmountOut Minimum amount of tokens the user will receive
   * @param tokenSwap0Info 
   * @param tokenSwap1Info 
   */
  async swap(
    userTransferAuthority: Account,
    userSource: PublicKey,
    userDestination: PublicKey,
    amountIn: number | Numberu64,
    minimumAmountOut: number | Numberu64,
    tokenSwap0Info: TokenSwapInfo | null,
    tokenSwap1Info: TokenSwapInfo | null,
  ): Promise<TransactionSignature> {
    if (tokenSwap0Info === null && tokenSwap1Info === null) {
      throw new Error('tokenSwapInfo and tokenSwap1Info all null');
    }
    return await realSendAndConfirmTransaction(
      'swap',
      this.connection,
      new Transaction().add(
        OneSolProtocol.swapInstruction(
          this.protocolInfo,
          this.authority,
          userTransferAuthority.publicKey,
          this.tokenAccountKey,
          userSource,
          userDestination,
          this.tokenProgramId,
          tokenSwap0Info,
          tokenSwap1Info,
          this.protocolProgramId,
          amountIn,
          minimumAmountOut,
        ),
      ),
      this.payer,
      userTransferAuthority,
    );
  }

    /**
   * Swap token A for token B
   *
   * @param userTransferAuthority Account delegated to transfer user's tokens
   * @param userSource User's source token account
   * @param userDestination User's destination token account
   * @param amountIn Amount to transfer from source account
   * @param minimumAmountOut Minimum amount of tokens the user will receive
   * @param tokenSwap0Info 
   * @param tokenSwap1Info 
   */
    newSwapInstruction(
      userTransferAuthority: Account,
      userSource: PublicKey,
      userDestination: PublicKey,
      amountIn: number | Numberu64,
      minimumAmountOut: number | Numberu64,
      tokenSwap0Info: TokenSwapInfo | null,
      tokenSwap1Info: TokenSwapInfo | null,
    ): TransactionInstruction {
      if (tokenSwap0Info === null && tokenSwap1Info === null) {
        throw new Error('tokenSwapInfo and tokenSwap1Info all null');
      }
      return OneSolProtocol.swapInstruction(
            this.protocolInfo,
            this.authority,
            userTransferAuthority.publicKey,
            this.tokenAccountKey,
            userSource,
            userDestination,
            this.tokenProgramId,
            tokenSwap0Info,
            tokenSwap1Info,
            this.protocolProgramId,
            amountIn,
            minimumAmountOut,
          )
        
    }

  static swapInstruction(
    protocolAccount: PublicKey,
    authority: PublicKey,
    userTransferAuthority: PublicKey,
    protocolToken: PublicKey,
    userSource: PublicKey,
    userDestination: PublicKey,
    tokenProgramId: PublicKey,
    // token-swap key begin
    tokenSwap0Info: TokenSwapInfo | null,
    tokenSwap1Info: TokenSwapInfo | null,
    protocolProgramId: PublicKey,
    amountIn: number | Numberu64,
    minimumAmountOut: number | Numberu64,
  ): TransactionInstruction {

    const dataLayout = BufferLayout.struct([
      BufferLayout.u8('instruction'),
      Layout.uint64('amountIn'),
      Layout.uint64('minimumAmountOut'),
      BufferLayout.u8('dexesConfig'),
      BufferLayout.u8('tokenSwap0Flag'),
      BufferLayout.u8('tokenSwap0AccountsSize'),
      BufferLayout.u8('tokenSwap1Flag'),
      BufferLayout.u8('tokenSwap1AccountsSize'),
    ]);

    let ts0Keys = Array<AccountMeta>();
    let ts0Flag = 0;
    if (tokenSwap0Info !== null){
      ts0Flag = 1;
      ts0Keys = tokenSwap0Info.toKeys();
    };

    let ts1Keys = Array<AccountMeta>();
    let ts1Flag = 0;
    if (tokenSwap1Info !== null){
      ts1Flag = 1;
      ts1Keys = tokenSwap1Info.toKeys();
    };

    const data = Buffer.alloc(dataLayout.span);
    dataLayout.encode(
      {
        instruction: 1, // Swap instruction
        amountIn: new Numberu64(amountIn).toBuffer(),
        minimumAmountOut: new Numberu64(minimumAmountOut).toBuffer(),
        dexesConfig: 2,
        tokenSwap0Flag: ts0Flag,
        tokenSwap0AccountsSize: ts0Keys.length,
        tokenSwap1Flag: ts1Flag,
        tokenSwap1AccountsSize: ts1Keys.length,
      },
      data,
    );

    const keys = [
      {pubkey: protocolAccount, isSigner: false, isWritable: false},
      {pubkey: authority, isSigner: false, isWritable: false},
      {pubkey: userTransferAuthority, isSigner: true, isWritable: false},
      {pubkey: protocolToken, isSigner: false, isWritable: true},
      {pubkey: userSource, isSigner: false, isWritable: true},
      {pubkey: userDestination, isSigner: false, isWritable: true},
      {pubkey: tokenProgramId, isSigner: false, isWritable: false},
    ];
    for (var k of ts0Keys) {
      keys.push(
        k,
      );
    };
    for (var k of ts1Keys) {
      keys.push(
        k,
      );
    };
    
    return new TransactionInstruction({
      keys,
      programId: protocolProgramId,
      data,
    });
  }
}

export function realSendAndConfirmTransaction(
  title: string,
  connection: Connection,
  transaction: Transaction,
  ...signers: Array<Account>
): Promise<TransactionSignature> {
  return sendAndConfirmTransaction(connection, transaction, signers, {
    skipPreflight: false,
    commitment: 'recent',
    preflightCommitment: 'recent',
  });
}


export function deserializeAccount (info: any)  {
  const data = OneSolProtocolLayout.decode(info.account.data);

  const details = {
    pubkey: info.pubkey,
    account: {
      ...info.account,
    },
    info: data,
  };

  return details;
}

export async function getTokenSwapInfo(tokenSwapData: any, address: any, programId: any) {
      const [authority] = await PublicKey.findProgramAddress(
        [address.toBuffer()],
        programId,
      );
    
      const poolToken = new PublicKey(tokenSwapData.tokenPool);
      const feeAccount = new PublicKey(tokenSwapData.feeAccount);
      const tokenAccountA = new PublicKey(tokenSwapData.tokenAccountA);
      const tokenAccountB = new PublicKey(tokenSwapData.tokenAccountB);
    
      return new TokenSwapInfo(
        programId,
        address,
        authority,
        tokenAccountA,
        tokenAccountB,
        poolToken,
        feeAccount,
        null
      );

}

export async function getOneSolProtocol(
    onesolProtocolData: any,
    connection: Connection,
    address: PublicKey,
    programId: PublicKey,
    payer: Account
  ): Promise<OneSolProtocol> {
    if (onesolProtocolData.version !== 1) {
      throw new Error(`Invalid OneSolProtocol data`);
    }

    const [authority] = await PublicKey.findProgramAddress(
      [address.toBuffer()],
      programId,
    )

    return new OneSolProtocol(
      connection,
      address,
      programId,
      new PublicKey(onesolProtocolData.tokenProgramId),
      new PublicKey(onesolProtocolData.tokenAccount),
      authority,
      onesolProtocolData.nonce,
      payer,
    )
  }