import { Router } from 'express';
import {
  findOrCreateSparkWallet,
  getStaticDepositAddress
} from '../services/privySparkService.js';

export const bitcoinRouter = Router();

bitcoinRouter.post('/users/me/wallets/bitcoin', async (req, res) => {
  try {
    const { privyUserId } = req.body;

    if (!privyUserId) {
      return res.status(400).json({ error: 'privyUserId is required' });
    }

    const wallet = await findOrCreateSparkWallet(privyUserId);
    const walletId = wallet.id || wallet.wallet_id;
    const sparkAddress = wallet.address;

    const deposit = await getStaticDepositAddress(walletId);
    const bitcoinAddress = deposit?.data?.address ?? null;

    return res.status(200).json({
      walletId,
      sparkAddress,
      address: bitcoinAddress
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      error: error.message,
      details: error.data || null
    });
  }
});
