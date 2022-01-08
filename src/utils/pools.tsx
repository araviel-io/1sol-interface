import {
  AccountInfo,
  Connection,
  PublicKey,
  SystemProgram,
  Signer,
  Keypair,
  TransactionInstruction,
} from "@solana/web3.js";
import { Token, AccountLayout, ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";

import { sendTransaction } from "./connection";
import { notify } from "./notifications";
import {
  getCachedAccount,
} from "./accounts";
import {
  programIds,
} from "./ids";
import {
  TokenAccount,
  TokenSwapLayout,
} from "./../models";
import {
  OneSolProtocol,
  loadSaberStableSwap,
} from '../utils/onesol-protocol'
import {
  u64,
} from '@solana/spl-token';
import { CurrencyContextState } from '../utils/currencyPair'
import {
  EXCHANGER_SABER_STABLE_SWAP,
  ONESOL_PROGRAM_ID, WRAPPED_SOL_MINT,
} from "./constant";

export const isLatest = (swap: AccountInfo<Buffer>) => {
  return swap.data.length === TokenSwapLayout.span;
};

export const hasAccount = (
  owner: PublicKey,
  mint: PublicKey,
  excluded?: Set<string>
) => {
  const accountToFind = mint.toBase58();
  const account = getCachedAccount(
    (acc) =>
      acc.info.mint.toBase58() === accountToFind &&
      acc.info.owner.toBase58() === owner.toBase58() &&
      (excluded === undefined || !excluded.has(acc.pubkey.toBase58()))
  );
  const isWrappedSol = accountToFind === WRAPPED_SOL_MINT.toBase58();

  if (account && !isWrappedSol) {
    return true
  } else {
    return false
  }

}

export async function findOrCreateTokenAssociatedAccountByMint(
  payer: PublicKey,
  owner: PublicKey,
  instructions: TransactionInstruction[],
  cleanupInstructions: TransactionInstruction[],
  mint: PublicKey, // use to identify same type
  signers: Signer[],
  excluded?: Set<string>
): Promise<PublicKey> {
  const accountToFind = mint.toBase58();
  const account = getCachedAccount(
    (acc) =>
      acc.info.mint.toBase58() === accountToFind &&
      acc.info.owner.toBase58() === owner.toBase58() &&
      (excluded === undefined || !excluded.has(acc.pubkey.toBase58()))
  );
  const isWrappedSol = accountToFind === WRAPPED_SOL_MINT.toBase58();

  let toAccount: PublicKey;

  if (account && !isWrappedSol) {
    toAccount = account.pubkey;
  } else {
    // creating depositor pool account
    toAccount = await createSplAssociatedTokenAccount(
      instructions,
      payer,
      mint,
      owner,
    );

    if (isWrappedSol) {
      cleanupInstructions.push(
        Token.createCloseAccountInstruction(
          programIds().token,
          toAccount,
          payer,
          payer,
          []
        )
      );
    }
  }

  return toAccount;
}

async function findOrCreateAccountByMint(
  payer: PublicKey,
  owner: PublicKey,
  instructions: TransactionInstruction[],
  cleanupInstructions: TransactionInstruction[],
  accountRentExempt: number,
  mint: PublicKey, // use to identify same type
  signers: Signer[],
  excluded?: Set<string>
): Promise<PublicKey> {
  const accountToFind = mint.toBase58();
  const isWrappedSol = accountToFind === WRAPPED_SOL_MINT.toBase58();

  if (isWrappedSol) {
    // creating depositor pool account
    const newToAccount = createSplAccount(
      instructions,
      payer,
      accountRentExempt,
      mint,
      owner,
      AccountLayout.span
    );

    const toAccount = newToAccount.publicKey;
    signers.push(newToAccount);
    cleanupInstructions.push(
      Token.createCloseAccountInstruction(
        programIds().token,
        toAccount,
        payer,
        payer,
        []
      )
    );
    return toAccount
  } else {
    const associateTokenAddress = await Token.getAssociatedTokenAddress(ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, mint, owner)
    const account = getCachedAccount(
      (acc) =>
        acc.pubkey.equals(associateTokenAddress) &&
        acc.info.mint.toBase58() === accountToFind &&
        acc.info.owner.toBase58() === owner.toBase58() &&
        (excluded === undefined || !excluded.has(acc.pubkey.toBase58()))
    );

    if (account) {
      return account.pubkey;
    }
    return await createSplAssociatedTokenAccount(
      instructions,
      payer,
      mint,
      owner
    )
  }
}


export enum PoolOperation {
  Add,
  SwapGivenInput,
  SwapGivenProceeds,
}


function getWrappedAccount(
  instructions: TransactionInstruction[],
  cleanupInstructions: TransactionInstruction[],
  toCheck: TokenAccount | undefined,
  payer: PublicKey,
  amount: number,
  signers: Signer[]
) {
  if (toCheck && !toCheck.info.isNative) {
    return toCheck.pubkey;
  }

  const account = Keypair.generate();

  instructions.push(
    SystemProgram.createAccount({
      fromPubkey: payer,
      newAccountPubkey: account.publicKey,
      lamports: amount,
      space: AccountLayout.span,
      programId: programIds().token,
    })
  );

  instructions.push(
    Token.createInitAccountInstruction(
      programIds().token,
      WRAPPED_SOL_MINT,
      account.publicKey,
      payer
    )
  );

  cleanupInstructions.push(
    Token.createCloseAccountInstruction(
      programIds().token,
      account.publicKey,
      payer,
      payer,
      []
    )
  );

  signers.push(account);

  return account.publicKey;
}

function createSplAccount(
  instructions: TransactionInstruction[],
  payer: PublicKey,
  accountRentExempt: number,
  mint: PublicKey,
  owner: PublicKey,
  space: number
) {
  const account = Keypair.generate();

  instructions.push(
    SystemProgram.createAccount({
      fromPubkey: payer,
      newAccountPubkey: account.publicKey,
      lamports: accountRentExempt,
      space,
      programId: programIds().token,
    })
  );

  instructions.push(
    Token.createInitAccountInstruction(
      programIds().token,
      mint,
      account.publicKey,
      owner
    )
  );

  return account;
}

export async function createSplAssociatedTokenAccount(
  instructions: TransactionInstruction[],
  payer: PublicKey,
  mint: PublicKey,
  owner: PublicKey,
) {
  const associatedAddress = await Token.getAssociatedTokenAddress(
    ASSOCIATED_TOKEN_PROGRAM_ID,
    programIds().token,
    mint,
    owner,
  );

  instructions.push(
    Token.createAssociatedTokenAccountInstruction(
      ASSOCIATED_TOKEN_PROGRAM_ID,
      programIds().token,
      mint,
      associatedAddress,
      owner,
      payer,
    ))

  return associatedAddress;
}

export async function createTokenAccount(
  connection: Connection,
  wallet: any,
  mint: PublicKey,
) {
  const toAccountInstructions: TransactionInstruction[] = [];
  const toAccountigners: Signer[] = [];

  const account = await findOrCreateAccountByMint(
    wallet.publicKey,
    wallet.publicKey,
    toAccountInstructions,
    [],
    0,
    mint,
    toAccountigners
  )

  await sendTransaction(
    connection,
    wallet,
    toAccountInstructions,
    toAccountigners
  )

  notify({
    message: `Token account created`,
    type: "success",
    description: ``,
  });

  return account;
}

export interface TokenSwapAmountProps {
  input: number,
  output: number
}

export interface DistributionRoute {
  amount_in: number,
  amount_out: number,
  source_token_mint: {
    decimals: number,
    pubkey: string,
  },
  destination_token_mint: {
    decimals: number,
    pubkey: string,
  },
  exchanger_flag: string,
  program_id: string,
  pubkey: string,
  ext_pubkey: string,
  ext_program_id: string,
}

// for direct exhange (SOL -> USDC)
async function swap(
  {
    onesolProtocol,
    connection,
    fromMintKey,
    toMintKey,
    fromAccount,
    toAccount,
    route,
    slippage,
    instructions,
    signers,
    userTransferAuthority,
    feeTokenAccount,
    openOrders
  }:
    {
      onesolProtocol: OneSolProtocol,
      connection: Connection,
      wallet: any,
      fromMintKey: PublicKey,
      toMintKey: PublicKey,
      fromAccount: PublicKey,
      toAccount: PublicKey,
      route: DistributionRoute,
      slippage: number,
      instructions: TransactionInstruction[],
      signers: Signer[],
      userTransferAuthority: PublicKey,
      feeTokenAccount: PublicKey,
      openOrders?: PublicKey
    },
) {
  const {
    exchanger_flag,
    pubkey,
    program_id,
    amount_in,
    amount_out,
  } = route

  const amountIn = new u64(amount_in)
  const expectAmountOut = new u64(amount_out)
  const minimumAmountOut = new u64(amount_out * (1 - slippage))

  if (exchanger_flag === EXCHANGER_SABER_STABLE_SWAP) {
    const stableSwapInfo = await loadSaberStableSwap({
      connection,
      address: new PublicKey(pubkey),
      programId: new PublicKey(program_id)
    })

    await onesolProtocol.createSwapBySaberStableSwapInstruction({
      fromTokenAccountKey: fromAccount,
      toTokenAccountKey: toAccount,
      fromMintKey,
      toMintKey,
      userTransferAuthority,
      feeTokenAccount,
      amountIn,
      expectAmountOut,
      minimumAmountOut,
      stableSwapInfo,
    }, instructions, signers)
  }
}


export async function findOrCreateOnesolSwapInfo({
  onesolProtocol,
  wallet,
  signers,
  instructions,
}: {
  onesolProtocol: OneSolProtocol,
  wallet: any,
  instructions: Array<TransactionInstruction>,
  signers: Signer[],

}): Promise<PublicKey> {
  let pubkey
  let swapInfo = await onesolProtocol.findSwapInfo({ wallet: wallet.publicKey })

  if (!swapInfo) {
    pubkey = await onesolProtocol.createSwapInfo({
      owner: wallet.publicKey,
      instructions,
      signers
    })
  } else {
    pubkey = swapInfo.pubkey
  }

  return pubkey
}

export async function onesolProtocolSwap(
  connection: Connection,
  wallet: any,
  A: CurrencyContextState,
  B: CurrencyContextState,
  distribution: any,
  slippage: number,
  feeTokenAccount: PublicKey,
) {
  const onesolProtocol: OneSolProtocol = await OneSolProtocol.createOneSolProtocol({
    connection,
    wallet: wallet.publicKey,
    programId: ONESOL_PROGRAM_ID
  })
  console.log("ONESOL METHOD - have to be bypassed or tricked")
  if (!onesolProtocol) {
    console.log("not onesol")
    return
  }

  const { routes } = distribution


  if (routes.length === 1) {
    // direct exchange(SOL -> USDC)
    const [routes] = distribution.routes

    const instructions: TransactionInstruction[] = [];
    const cleanupInstructions: TransactionInstruction[] = [];
    const signers: Signer[] = [];

    const accountRentExempt = await connection.getMinimumBalanceForRentExemption(
      AccountLayout.span
    );


    let openOrders: PublicKey


    const fromMintKey = new PublicKey(A.mintAddress)
    const toMintKey = new PublicKey(B.mintAddress)

    const fromAccount = getWrappedAccount(
      instructions,
      cleanupInstructions,
      A.account,
      wallet.publicKey,
      distribution.amount_in + accountRentExempt,
      signers
    );

    const toAccount = await findOrCreateAccountByMint(
      wallet.publicKey,
      wallet.publicKey,
      instructions,
      cleanupInstructions,
      accountRentExempt,
      toMintKey,
      signers
    )

    const promises = routes.map(async (route: any) => swap({
      onesolProtocol,
      connection,
      wallet,
      fromMintKey,
      toMintKey,
      fromAccount,
      toAccount,
      route,
      slippage,
      instructions,
      signers,
      userTransferAuthority: wallet.publicKey,
      feeTokenAccount,
      openOrders
    }))

    await Promise.all(promises)

    const txid = await sendTransaction(
      connection,
      wallet,
      instructions.concat(cleanupInstructions),
      signers
    );

    notify({
      message: "Trade executed.",
      type: "success",
      description: `Transaction - ${txid}`,
      txid
    });
  } else {
    return
  }
}
