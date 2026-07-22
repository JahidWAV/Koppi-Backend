import type { VercelRequest, VercelResponse } from '@vercel/node'

type Direction = 'incoming' | 'outgoing' | 'neutral'

type WalletActivityItem = {
  id: string
  chain: string
  title: string
  subtitle: string
  amountText: string
  fiatText: string | null
  timestamp: string
  txHash: string | null
  status: string
  direction: Direction
}

type PrivyTransactionResponse = {
  transactions: PrivyTransaction[]
  next_cursor: string | null
}

type PrivyTransaction = {
  caip2: string
  transaction_hash: string | null
  user_operation_hash?: string
  status: string
  created_at: number
  sponsored?: boolean
  details: PrivyTransactionDetail | null
  privy_transaction_id: string
  wallet_id: string
}

type PrivyTransactionDetail =
  | TransferSentDetail
  | TransferReceivedDetail
  | null

type BaseDetail = {
  type: 'transfer_sent' | 'transfer_received'
  sender: string
  sender_privy_user_id: string | null
  recipient: string
  recipient_privy_user_id: string | null
  chain: string
  asset: string
  raw_value: string
  raw_value_decimals: number
  display_values: Record<string, string>
}

type TransferSentDetail = BaseDetail & { type: 'transfer_sent' }
type TransferReceivedDetail = BaseDetail & { type: 'transfer_received' }

const PRIVY_API_BASE = 'https://api.privy.io'
const COPPI_API_BASE = 'https://api.privy.io'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const auth = req.headers.authorization
    const privyAppId = process.env.PRIVY_APP_ID
    const privyAppSecret = process.env.PRIVY_APP_SECRET
    const baseWalletId = process.env.PRIVY_BASE_WALLET_ID
    const solanaWalletId = process.env.PRIVY_SOLANA_WALLET_ID

    if (!auth || !auth.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'missing_bearer_token' })
    }

    if (!privyAppId || !privyAppSecret) {
      return res.status(500).json({ error: 'missing_privy_credentials' })
    }

    if (!baseWalletId || !solanaWalletId) {
      return res.status(500).json({ error: 'missing_wallet_ids' })
    }

    const userAccessToken = auth.slice('Bearer '.length).trim()

    const [baseTxs, solTxs] = await Promise.all([
      fetchPrivyWalletTransactions({
        walletId: baseWalletId,
        chain: 'base',
        privyAppId,
        privyAppSecret
      }),
      fetchPrivyWalletTransactions({
        walletId: solanaWalletId,
        chain: 'solana',
        privyAppId,
        privyAppSecret
      })
    ])

    const btcTxs = await fetchBitcoinTransactions(req.query.bitcoinAddress)

    const items: WalletActivityItem[] = [
      ...baseTxs,
      ...solTxs,
      ...btcTxs
    ].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())

    return res.status(200).json({ items })
  } catch (error: any) {
    console.error('activity error', error)
    return res.status(500).json({
      error: 'activity_failed',
      message: error?.message ?? 'Unknown error'
    })
  }
}

async function fetchPrivyWalletTransactions(opts: {
  walletId: string
  chain: 'base' | 'solana'
  privyAppId: string
  privyAppSecret: string
}): Promise<WalletActivityItem[]> {
  const url = new URL(`${PRIVY_API_BASE}/v1/wallets/${opts.walletId}/transactions`)
  url.searchParams.set('chain', opts.chain)
  url.searchParams.set('limit', '100')

  if (opts.chain === 'base') {
    url.searchParams.set('asset', 'eth')
  }
  if (opts.chain === 'solana') {
    url.searchParams.set('asset', 'sol')
  }

  const authorization = Buffer.from(`${opts.privyAppId}:${opts.privyAppSecret}`).toString('base64')

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      Authorization: `Basic ${authorization}`,
      'privy-app-id': opts.privyAppId,
      Accept: 'application/json'
    }
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Privy transactions failed for ${opts.chain}: ${response.status} ${text}`)
  }

  const json = (await response.json()) as PrivyTransactionResponse

  return (json.transactions ?? []).map((tx) => mapPrivyTransaction(tx))
}

function mapPrivyTransaction(tx: PrivyTransaction): WalletActivityItem {
  const details = tx.details
  const direction: Direction = details?.type === 'transfer_received' ? 'incoming' : 'outgoing'
  const chain = details?.chain ?? tx.caip2.split(':')[1] ?? 'unknown'
  const asset = (details?.asset ?? 'asset').toUpperCase()
  const amount = details?.display_values?.[details?.asset ?? ''] ?? details?.raw_value ?? '0'
  const sign = direction === 'incoming' ? '+' : '-'
  const title = direction === 'incoming' ? `Received ${asset}` : `Sent ${asset}`
  const subtitle = prettyChain(chain)

  return {
    id: tx.privy_transaction_id,
    chain,
    title,
    subtitle,
    amountText: `${sign}${amount} ${asset}`,
    fiatText: null,
    timestamp: new Date(tx.created_at).toISOString(),
    txHash: tx.transaction_hash,
    status: tx.status,
    direction
  }
}

function prettyChain(chain: string) {
  switch (chain.toLowerCase()) {
    case 'base':
      return 'Base'
    case 'solana':
      return 'Solana'
    case 'ethereum':
      return 'Ethereum'
    default:
      return chain.charAt(0).toUpperCase() + chain.slice(1)
  }
}

async function fetchBitcoinTransactions(_bitcoinAddress: unknown): Promise<WalletActivityItem[]> {
  return []
}
