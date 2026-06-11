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

  // GET /qr/state?token=xxx — polled every 2s by the browser
  @Get('state')
  getState(@Query('token') token: string): object {
    this.validateToken(token);
    return {
      isConnected:   this.whatsappService.isConnected,
      qrDataUrl:     this.whatsappService.qrDataUrl,
      qrIsValid:     this.whatsappService.qrIsValid,
      qrGeneratedAt: this.whatsappService.qrGeneratedAt,
    };
  }

  // GET /qr?token=xxx — the HTML page
  @Get()
  getQr(@Query('token') token: string, @Res() res: Response): void {
    this.validateToken(token);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(this.buildHtml(token));
  }

  private validateToken(token: string): void {
    const secret = this.configService.get<string>('whatsapp.qrToken');
    if (!secret || token !== secret) {
      throw new UnauthorizedException('Invalid token');
    }
  }

  private buildHtml(token: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>WhatsApp QR — Healthcare Bot</title>
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="22" fill="#1d4ed8"/><path d="M50 18C32.3 18 18 32.3 18 50c0 5.7 1.6 11 4.3 15.6L18 82l17-4.2C39.2 80.5 44.5 82 50 82c17.7 0 32-14.3 32-32S67.7 18 50 18zm0 58c-5 0-9.7-1.4-13.7-3.8l-1-.6-9.9 2.5 2.6-9.6-.6-1C25.5 59.5 24 54.9 24 50c0-14.4 11.6-26 26-26s26 11.6 26 26-11.6 26-26 26zm14.2-19.5c-.8-.4-4.6-2.2-5.3-2.5-.7-.3-1.2-.4-1.7.4-.5.8-1.9 2.5-2.4 3-.4.5-.9.6-1.7.2-.8-.4-3.3-1.2-6.3-3.8-2.3-2-3.9-4.5-4.3-5.3-.4-.8 0-1.2.3-1.6.3-.3.8-.9 1.1-1.3.4-.4.5-.8.7-1.3.2-.5.1-1-.1-1.3-.2-.4-1.7-4-2.3-5.5-.6-1.4-1.2-1.2-1.7-1.2-.4 0-.9 0-1.4 0s-1.3.2-2 1c-.7.7-2.6 2.5-2.6 6.2s2.7 7.2 3 7.7c.4.5 5.2 8 12.6 11.2 1.8.8 3.1 1.2 4.2 1.6 1.8.6 3.4.5 4.6.3 1.4-.2 4.3-1.7 4.9-3.4.6-1.6.6-3 .4-3.3-.2-.3-.7-.5-1.5-.9z" fill="white"/></svg>`)}">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f1f5f9;
      min-height: 100vh;
      display: flex; align-items: center; justify-content: center;
      padding: 1.5rem;
    }
    .card {
      background: #fff;
      border-radius: 20px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.06), 0 16px 48px rgba(0,0,0,0.08);
      padding: 2.5rem 2rem;
      max-width: 420px; width: 100%;
      text-align: center;
    }
    .icon {
      width: 52px; height: 52px;
      background: linear-gradient(135deg,#1d4ed8,#2563eb);
      border-radius: 14px;
      display: flex; align-items: center; justify-content: center;
      margin: 0 auto 1.25rem;
      box-shadow: 0 4px 12px rgba(37,99,235,.3);
    }
    h1 { font-size: 1.2rem; font-weight: 700; color: #0f172a; }
    .subtitle { font-size: .825rem; color: #94a3b8; margin-top: .2rem; margin-bottom: 1.5rem; }
    .status {
      display: inline-flex; align-items: center; gap: .4rem;
      padding: .35rem .85rem; border-radius: 999px;
      font-size: .775rem; font-weight: 600; margin-bottom: 1.5rem;
      transition: background .3s, color .3s, border-color .3s;
    }
    .status-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
    .status.connected { color:#15803d; background:#f0fdf4; border:1px solid #bbf7d0; }
    .status.connected .status-dot { background:#22c55e; }
    .status.scanning  { color:#1d4ed8; background:#eff6ff; border:1px solid #bfdbfe; }
    .status.scanning  .status-dot { background:#3b82f6; animation:pulse 1.2s infinite; }
    .status.expired   { color:#b45309; background:#fffbeb; border:1px solid #fde68a; }
    .status.expired   .status-dot { background:#f59e0b; animation:pulse 1s infinite; }
    .status.waiting   { color:#6b7280; background:#f9fafb; border:1px solid #e5e7eb; }
    .status.waiting   .status-dot { background:#9ca3af; animation:pulse 1.5s infinite; }
    @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.25} }
    .qr-section {
      min-height: 240px;
      display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      margin-bottom: 1.25rem; position: relative;
    }
    #qr-img {
      border-radius: 12px;
      box-shadow: 0 2px 16px rgba(0,0,0,.1);
      max-width: 260px; width: 100%;
      display: none;
    }
    #qr-img.visible { display: block; opacity: 1; }
    #qr-img.faded   { display: block; opacity: .15; filter: blur(2px); }
    .state-msg { font-size: .9rem; color: #64748b; line-height: 1.7; display: none; }
    .state-msg.visible { display: block; }
    .state-msg.success { color: #15803d; font-weight: 600; font-size: 1rem; }
    #expired-overlay {
      position: absolute; top: 50%; left: 50%;
      transform: translate(-50%,-50%);
      background: rgba(255,255,255,.93);
      border: 1.5px solid #fde68a; border-radius: 10px;
      padding: .5rem .9rem; font-size: .82rem; font-weight: 600;
      color: #b45309; white-space: nowrap; display: none;
    }
    #expired-overlay.visible { display: block; }
    #countdown-wrap {
      margin-top: .75rem;
      display: none; align-items: center; justify-content: center; gap: .5rem;
    }
    #countdown-wrap.visible { display: flex; }
    .cring { width: 36px; height: 36px; flex-shrink: 0; }
    .cring svg { transform: rotate(-90deg); }
    .cring .track { fill: none; stroke: #e2e8f0; stroke-width: 3; }
    .cring .fill  { fill: none; stroke-width: 3; stroke-linecap: round; transition: stroke .4s ease; }
    .countdown-label { font-size: .8rem; font-weight: 600; color: #475569; }
    .countdown-label span { color: #0f172a; font-size: .9rem; }
    #instructions {
      font-size: .775rem; color: #94a3b8; line-height: 1.7;
      border-top: 1px solid #f1f5f9; padding-top: 1rem;
    }
    .step { display: flex; align-items: flex-start; gap: .5rem; text-align: left; margin-top: .35rem; }
    .step-num {
      min-width: 18px; height: 18px; background: #e2e8f0; border-radius: 50%;
      font-size: .7rem; font-weight: 700; color: #475569;
      display: flex; align-items: center; justify-content: center;
      flex-shrink: 0; margin-top: 1px;
    }
  </style>
</head>
<body>
<div class="card">
  <div class="icon">
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="white"
         stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
    </svg>
  </div>
  <h1>Healthcare Bot</h1>
  <p class="subtitle">WhatsApp Connection</p>

  <div class="status waiting" id="status-pill">
    <span class="status-dot"></span>
    <span id="status-text">Connecting…</span>
  </div>

  <div class="qr-section">
    <img id="qr-img" alt="WhatsApp QR Code">
    <div id="expired-overlay">⏰ Refreshing QR…</div>
    <p class="state-msg" id="msg-generating">Generating QR code…<br>usually a few seconds.</p>
    <p class="state-msg success" id="msg-connected">WhatsApp is connected.<br>No QR code needed.</p>
    <div id="countdown-wrap">
      <div class="cring">
        <svg viewBox="0 0 36 36" width="36" height="36">
          <circle class="track" cx="18" cy="18" r="15.9"/>
          <circle class="fill" id="ring-fill"
            cx="18" cy="18" r="15.9"
            stroke="#3b82f6"
            stroke-dasharray="100"
            stroke-dashoffset="0"/>
        </svg>
      </div>
      <span class="countdown-label">Expires in <span id="countdown">--</span></span>
    </div>
  </div>

  <div id="instructions">
    <strong style="color:#64748b">How to scan:</strong>
    <div class="step"><span class="step-num">1</span><span>Open WhatsApp on your phone</span></div>
    <div class="step"><span class="step-num">2</span><span>Tap ⋮ (Android) or Settings (iOS) → Linked Devices</span></div>
    <div class="step"><span class="step-num">3</span><span>Tap <strong>Link a Device</strong></span></div>
    <div class="step"><span class="step-num">4</span><span>Point your camera at the QR — you have ~20 seconds</span></div>
  </div>
</div>

<script>
(function () {
  'use strict';

  var TOKEN     = ${JSON.stringify(token)};
  var QR_TTL_MS = 20000;

  var pill         = document.getElementById('status-pill');
  var pillText     = document.getElementById('status-text');
  var qrImg        = document.getElementById('qr-img');
  var expiredOvl   = document.getElementById('expired-overlay');
  var msgGen       = document.getElementById('msg-generating');
  var msgConn      = document.getElementById('msg-connected');
  var cdWrap       = document.getElementById('countdown-wrap');
  var cdLabel      = document.getElementById('countdown');
  var ringFill     = document.getElementById('ring-fill');
  var instructions = document.getElementById('instructions');

  var currentQrUrl = null;
  var lastState    = null;
  var rafHandle    = null;
  var qrGenAt      = null;

  // ── Pure polling — no SSE (blocked by Cloudflare free tier) ───────────────
  fetchState();
  setInterval(fetchState, 2000);

  function fetchState() {
    fetch('/qr/state?token=' + TOKEN)
      .then(function (r) { return r.json(); })
      .then(render)
      .catch(function () {});
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  function render(data) {
    if (data.isConnected) {
      if (lastState !== 'connected') {
        lastState = 'connected';
        setStatus('connected', '✅ Connected');
        showOnly(msgConn);
        stopRaf();
        cdWrap.className = '';
        instructions.style.display = 'none';
      }
      return;
    }

    instructions.style.display = '';

    if (data.qrDataUrl && data.qrIsValid) {
      if (data.qrDataUrl !== currentQrUrl) {
        currentQrUrl = data.qrDataUrl;
        qrImg.src    = data.qrDataUrl;
        qrGenAt      = data.qrGeneratedAt;
        stopRaf();
        startRaf();
      }
      if (lastState !== 'qr_valid') {
        lastState = 'qr_valid';
        setStatus('scanning', '📷 Ready to scan');
        qrImg.className    = 'visible';
        expiredOvl.className = '';
        showOnly(null);
        cdWrap.className   = 'visible';
      }
    } else if (data.qrDataUrl && !data.qrIsValid) {
      if (lastState !== 'qr_expired') {
        lastState = 'qr_expired';
        setStatus('expired', '⏰ Refreshing QR…');
        qrImg.className      = 'faded';
        expiredOvl.className = 'visible';
        showOnly(null);
        stopRaf();
        cdWrap.className = '';
      }
    } else {
      if (lastState !== 'generating') {
        lastState = 'generating';
        setStatus('waiting', '⏳ Generating QR…');
        qrImg.className      = '';
        expiredOvl.className = '';
        showOnly(msgGen);
        stopRaf();
        cdWrap.className = '';
      }
    }
  }

  // ── RAF countdown — driven by server-reported qrGeneratedAt ───────────────
  function startRaf() {
    stopRaf();
    (function tick() {
      if (!qrGenAt) { rafHandle = requestAnimationFrame(tick); return; }
      var elapsed   = Date.now() - qrGenAt;
      var remaining = Math.max(0, QR_TTL_MS - elapsed);
      var secs      = Math.ceil(remaining / 1000);
      var pct       = Math.round((remaining / QR_TTL_MS) * 100);

      cdLabel.textContent = secs + 's';
      ringFill.setAttribute('stroke-dashoffset', String(100 - pct));
      ringFill.setAttribute('stroke',
        secs > 10 ? '#3b82f6' : secs > 5 ? '#f59e0b' : '#ef4444');

      rafHandle = requestAnimationFrame(tick);
    }());
  }

  function stopRaf() {
    if (rafHandle) { cancelAnimationFrame(rafHandle); rafHandle = null; }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  function showOnly(el) {
    [msgGen, msgConn].forEach(function (m) {
      m.className = 'state-msg' + (m === msgConn ? ' success' : '');
    });
    if (el) el.className += ' visible';
  }

  function setStatus(cls, text) {
    pill.className  = 'status ' + cls;
    pillText.textContent = text;
  }

}());
</script>
</body>
</html>`;
  }
}