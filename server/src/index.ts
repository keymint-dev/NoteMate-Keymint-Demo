import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import axios from 'axios';
import { createHash } from 'crypto';
import { z } from 'zod';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const KEYMINT_API = 'https://api.keymint.dev';
const accessToken = process.env.KEYMINT_ACCESS_TOKEN;
const productId = process.env.KEYMINT_PRODUCT_ID;

if (!accessToken || !productId) {
  console.warn('Missing KEYMINT_ACCESS_TOKEN or KEYMINT_PRODUCT_ID in environment.');
}

const api = axios.create({
  baseURL: KEYMINT_API,
  headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }
});

app.get('/health', (_req: express.Request, res: express.Response) => res.json({ ok: true, app: 'NoteMate' }));

// --- Active license cache ---
interface ActiveLicenseState {
  licenseKey: string;
  hostId: string;
  tier: 'FREE' | 'PRO';
  features: string[]; // e.g. ['exportPDF','darkMode']
  lastActivatedAt: string;
  licenseeName?: string;
  licenseeEmail?: string;
}
let activeLicense: ActiveLicenseState | null = null;

// Enter & activate existing license key (any valid key -> PRO tier)
app.post('/api/enter-license', async (req: express.Request, res: express.Response) => {
  try {
    const schema = z.object({ licenseKey: z.string(), deviceTag: z.string().optional(), hostId: z.string().optional() });
    const { licenseKey, deviceTag, hostId } = schema.parse(req.body);
    // Stable fallback: a random hostId per call would burn one activation
    // slot per launch. Derive it from the key so repeat launches reuse it.
    const activationHost = hostId || `demo-${createHash('sha256').update(licenseKey).digest('hex').slice(0, 16)}`;
    const payload = { productId, licenseKey, hostId: activationHost, deviceTag };
    // Use new endpoint per docs
    const actResp = await api.post('/key/activate', payload);
    // Optionally, fetch entitlements/info
    // const infoResp = await api.get('/key', { params: { productId, licenseKey } });
    activeLicense = {
      licenseKey,
      hostId: activationHost,
      tier: 'PRO',
      features: ['exportPDF', 'darkMode'],
      lastActivatedAt: new Date().toISOString(),
      licenseeName: actResp.data.licenseeName,
      licenseeEmail: actResp.data.licenseeEmail
    };
    res.json({ message: 'License activated', tier: activeLicense.tier, features: activeLicense.features, hostId: activationHost });
  } catch (e: any) {
    if (e.response) return res.status(e.response.status).json(e.response.data);
    res.status(500).json({ message: 'Server error', error: e.message });
  }
});

// New clear license endpoint for demo resets
app.post('/api/clear-license', (_req: express.Request, res: express.Response) => {
  activeLicense = null;
  res.json({ message: 'License cleared', tier: 'FREE', features: [] });
});

app.get('/api/license-state', (_req: express.Request, res: express.Response) => {
  if (!activeLicense) return res.json({ tier: 'FREE', features: [] });
  res.json(activeLicense);
});

function requireFeature(feature: string) {
  return (_req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!activeLicense) return res.status(402).json({ message: 'No active license', feature });
    if (!activeLicense.features.includes(feature)) return res.status(403).json({ message: 'Feature not available for current license', feature });
    next();
  };
}

app.get('/api/feature/exportPDF', requireFeature('exportPDF'), (_req, res) => {
  res.json({ ok: true, feature: 'exportPDF' });
});
app.get('/api/feature/darkMode', requireFeature('darkMode'), (_req, res) => {
  res.json({ ok: true, feature: 'darkMode' });
});

// Catch-all for removed legacy endpoints
app.all(['/api/create-key','/api/activate-key','/api/deactivate-key','/api/licenses'], (_req, res) => {
  res.status(410).json({ message: 'Endpoint removed in NoteMate demo refactor' });
});

const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`NoteMate server running on :${port}`));
