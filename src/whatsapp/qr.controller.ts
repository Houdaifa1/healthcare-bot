import {
  Controller,
  Get,
  Query,
  UnauthorizedException,
  Res,
  Sse,
  MessageEvent,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { Observable, interval, map } from 'rxjs';
import { WhatsAppService } from './whatsapp.service';

@Controller('qr')
export class QrController {
  constructor(
    private readonly whatsappService: WhatsAppService,
    private readonly configService: ConfigService,
  ) {}

  @Sse('events')
  streamQrState(
    @Query('token') token: string,
    @Res({ passthrough: false }) res: Response,
  ): Observable<MessageEvent> {
    this.validateToken(token);

    res.setHeader('Cache-Control', 'no-cache, no-store');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Transfer-Encoding', 'identity');
    res.flushHeaders();

    return interval(1000).pipe(
      map(() => ({
        data: JSON.stringify(this.getState()),
      })),
    );
  }

  @Get('state')
  getStateEndpoint(@Query('token') token: string): object {
    this.validateToken(token);
    return this.getState();
  }

  @Get()
  getQr(
    @Query('token') token: string,
    @Res() res: Response,
  ): void {
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

  private getState() {
    return {
      isConnected: this.whatsappService.isConnected,
      qrDataUrl: this.whatsappService.qrDataUrl,
      qrIsValid: this.whatsappService.qrIsValid,
      qrGeneratedAt: this.whatsappService.qrGeneratedAt,
    };
  }

  private buildHtml(token: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>WhatsApp QR — Healthcare Bot</title>
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
    .status-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; transition: background .3s; }
    .status.connected   { color:#15803d; background:#f0fdf4; border:1px solid #bbf7d0; }
    .status.connected   .status-dot { background:#22c55e; }
    .status.scanning    { color:#1d4ed8; background:#eff6ff; border:1px solid #bfdbfe; }
    .status.scanning    .status-dot { background:#3b82f6; animation:pulse 1.2s infinite; }
    .status.expired     { color:#b45309; background:#fffbeb; border:1px solid #fde68a; }
    .status.expired     .status-dot { background:#f59e0b; animation:pulse 1s infinite; }
    .status.waiting     { color:#6b7280; background:#f9fafb; border:1px solid #e5e7eb; }
    .status.waiting     .status-dot { background:#9ca3af; animation:pulse 1.5s infinite; }
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
      transition: opacity .25s ease;
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
    .transport-bar { margin-top: .85rem; font-size: .68rem; color: #cbd5e1; font-family: monospace; }
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

  <div class="transport-bar" id="transport-bar">initializing…</div>
</div>

<script>
(function () {
  'use strict';

  var TOKEN      = ${JSON.stringify(token)};
  var QR_TTL_MS  = 20000;

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
  var transportBar = document.getElementById('transport-bar');

  var currentQrUrl = null;
  var lastState    = null;
  var rafHandle    = null;
  var qrGenAt      = null; // server-reported qrGeneratedAt (ms epoch)

  // ── Transport ──────────────────────────────────────────────────────────────
  var sseActive  = false;
  var pollHandle = null;

  var stallTimer = setTimeout(function () {
    if (!sseActive) {
      transportBar.textContent = 'transport: SSE stalled → polling 2s';
      startPolling();
    }
  }, 8000);

  try {
    var es = new EventSource('/qr/events?token=' + TOKEN);
    es.onmessage = function (e) {
      if (!sseActive) {
        sseActive = true;
        clearTimeout(stallTimer);
        transportBar.textContent = 'transport: SSE ✓';
      }
      render(JSON.parse(e.data));
    };
    es.onerror = function () {
      if (!sseActive) {
        clearTimeout(stallTimer);
        es.close();
        transportBar.textContent = 'transport: SSE error → polling 2s';
        startPolling();
      } else {
        transportBar.textContent = 'transport: SSE dropped → polling 2s';
        if (!pollHandle) startPolling();
      }
    };
  } catch (e) {
    clearTimeout(stallTimer);
    transportBar.textContent = 'transport: SSE unavailable → polling 2s';
    startPolling();
  }

  function startPolling() {
    if (pollHandle) return;
    fetchState();
    pollHandle = setInterval(fetchState, 2000);
  }

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
        qrImg.src = data.qrDataUrl;
        qrGenAt = data.qrGeneratedAt; // update timestamp when QR rotates
      } else if (data.qrGeneratedAt && data.qrGeneratedAt !== qrGenAt) {
        qrGenAt = data.qrGeneratedAt;
      }
      if (lastState !== 'qr_valid') {
        lastState = 'qr_valid';
        setStatus('scanning', '📷 Ready to scan');
        qrImg.className = 'visible';
        expiredOvl.className = '';
        showOnly(null);
        cdWrap.className = 'visible';
        startRaf();
      }
    } else if (data.qrDataUrl && !data.qrIsValid) {
      if (lastState !== 'qr_expired') {
        lastState = 'qr_expired';
        setStatus('expired', '⏰ Refreshing QR…');
        qrImg.className = 'faded';
        expiredOvl.className = 'visible';
        showOnly(null);
        stopRaf();
        cdWrap.className = '';
      }
    } else {
      if (lastState !== 'generating') {
        lastState = 'generating';
        setStatus('waiting', '⏳ Generating QR…');
        qrImg.className = '';
        expiredOvl.className = '';
        showOnly(msgGen);
        stopRaf();
        cdWrap.className = '';
      }
    }
  }

  // ── RAF-driven countdown — perfect sync with server timestamp ──────────────
  function startRaf() {
    stopRaf();
    function tick() {
      if (!qrGenAt) { rafHandle = requestAnimationFrame(tick); return; }
      var elapsed   = Date.now() - qrGenAt;
      var remaining = Math.max(0, QR_TTL_MS - elapsed);
      var secs      = Math.ceil(remaining / 1000);
      var pct       = Math.round((remaining / QR_TTL_MS) * 100);
      pct = Math.min(100, Math.max(0, pct));

      cdLabel.textContent = secs + 's';
      ringFill.setAttribute('stroke-dashoffset', String(100 - pct));
      ringFill.setAttribute('stroke',
        secs > 10 ? '#3b82f6' : secs > 5 ? '#f59e0b' : '#ef4444'
      );

      rafHandle = requestAnimationFrame(tick);
    }
    rafHandle = requestAnimationFrame(tick);
  }

  function stopRaf() {
    if (rafHandle) { cancelAnimationFrame(rafHandle); rafHandle = null; }
  }

  // ── DOM helpers ────────────────────────────────────────────────────────────
  function showOnly(el) {
    [msgGen, msgConn].forEach(function (m) {
      m.className = 'state-msg' + (m === msgConn ? ' success' : '');
    });
    if (el) el.className += ' visible';
  }

  function setStatus(cls, text) {
    pill.className = 'status ' + cls;
    pillText.textContent = text;
  }

}());
</script>
</body>
</html>`;
  }
}