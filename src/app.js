import express from 'express';
import cors from 'cors';
import { bitcoinRouter } from './routes/bitcoin.js';

export const app = express();

app.use(cors());
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.use(bitcoinRouter);
