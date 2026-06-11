import {
  Controller,
  Get,
  Query,
  UnauthorizedException,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { WhatsAppService } from './whatsapp.service';

@Controller('qr')
export class QrController {
  constructor(
    private readonly whatsappService: WhatsAppService,
    private readonly configService: ConfigService,
  ) {}

  @Get()
  getQr(
    @Query('token') token: string,
    @Res() res: Response,
  ): void {
    const secret = this.configService.get<string>('whatsapp.qrToken');

    if (!secret || token !== secret) {
      throw new UnauthorizedException('Invalid token');
    }

    const { qrDataUrl, isConnected } = this.whatsappService;

    const statusColor = isConnected ? '#16a34a' : '#dc2626';
    const statusText = isConnected ? '✅ Connected' : '⏳ Waiting for scan...';
    const autoRefresh = !isConnected
      ? `<meta http-equiv="refresh" content="5">`
      : '';

    const qrSection = qrDataUrl
      ? `<img src="${qrDataUrl}" alt="WhatsApp QR Code" style="border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,0.12);">`
      : isConnected
        ? `<p style="font-size:1.1rem;color:#16a34a;font-weight:600;">WhatsApp is connected. No QR needed.</p>`
        : `<p style="color:#6b7280;">Generating QR code... refresh in a few seconds.</p>`;

    res.setHeader('Content-Type', 'text/html');
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  ${autoRefresh}
  <title>WhatsApp QR — Healthcare Bot</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #f9fafb;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 2rem;
    }
    .card {
      background: white;
      border-radius: 16px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.08), 0 8px 32px rgba(0,0,0,0.06);
      padding: 2.5rem;
      max-width: 480px;
      width: 100%;
      text-align: center;
    }
    .logo {
      width: 48px; height: 48px;
      background: #1d4ed8;
      border-radius: 12px;
      display: flex; align-items: center; justify-content: center;
      margin: 0 auto 1.5rem;
    }
    h1 { font-size: 1.25rem; font-weight: 600; color: #111827; margin-bottom: 0.5rem; }
    .subtitle { font-size: 0.875rem; color: #6b7280; margin-bottom: 1.5rem; }
    .status {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.375rem 0.875rem;
      border-radius: 999px;
      font-size: 0.8rem;
      font-weight: 600;
      color: ${statusColor};
      background: ${isConnected ? '#f0fdf4' : '#fef2f2'};
      border: 1px solid ${isConnected ? '#bbf7d0' : '#fecaca'};
      margin-bottom: 1.5rem;
    }
    .qr-wrap { margin: 0 auto 1.5rem; }
    .instructions {
      font-size: 0.8rem;
      color: #9ca3af;
      line-height: 1.6;
    }
    .instructions strong { color: #6b7280; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
      </svg>
    </div>
    <h1>Healthcare Bot</h1>
    <p class="subtitle">WhatsApp Connection</p>
    <div class="status">${statusText}</div>
    <div class="qr-wrap">${qrSection}</div>
    ${!isConnected ? `
    <p class="instructions">
      <strong>How to scan:</strong><br>
      Open WhatsApp → tap ⋮ → Linked Devices → Link a Device → scan this QR code.<br><br>
      Page refreshes automatically every 5 seconds.
    </p>` : ''}
  </div>
</body>
</html>`);
  }
}