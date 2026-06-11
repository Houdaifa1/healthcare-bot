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
import { Observable, interval, map, takeWhile } from 'rxjs';
import { WhatsAppService } from './whatsapp.service';

@Controller('qr')
export class QrController {
  constructor(
    private readonly whatsappService: WhatsAppService,
    private readonly configService: ConfigService,
  ) {}

  // ─── SSE endpoint — streams QR state every second ─────────────────────────
  // GET /qr/events?token=xxx
  // Note: X-Accel-Buffering: no tells Nginx to flush immediately.
  // Cloudflare on free tier buffers SSE — the client JS falls back to polling
  // automatically if the SSE connection stalls.
  @Sse('events')
  streamQrState(
    @Query('token') token: string,
    @Res({ passthrough: false }) res: Response,
  ): Observable<MessageEvent> {
    this.validateToken(token);

    // Force Nginx / upstream proxies to stop buffering this response
    res.setHeader('Cache-Control', 'no-cache, no-store');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Transfer-Encoding', 'identity');
    res.flushHeaders();

    return interval(1000).pipe(
      map(() => ({
        data: JSON.stringify({
          isConnected: this.whatsappService.isConnected,
          qrDataUrl: this.whatsappService.qrDataUrl,
          qrIsValid: this.whatsappService.qrIsValid,
          qrSecondsRemaining: this.whatsappService.qrSecondsRemaining,
          qrAgeSeconds: this.whatsappService.qrAgeSeconds,
        }),
      })),
      takeWhile(() => !this.whatsappService.isConnected, true),
    );
  }

  // ─── JSON state endpoint — polling fallback + direct state checks ─────────
  // GET /qr/state?token=xxx
  @Get('state')
  getState(@Query('token') token: string): object {
    this.validateToken(token);
    return {
      isConnected: this.whatsappService.isConnected,
      qrDataUrl: this.whatsappService.qrDataUrl,
      qrIsValid: this.whatsappService.qrIsValid,
      qrSecondsRemaining: this.whatsappService.qrSecondsRemaining,
      qrAgeSeconds: this.whatsappService.qrAgeSeconds,
    };
  }

  // ─── Main QR page ──────────────────────────────────────────────────────────
  // GET /qr?token=xxx
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

  // ─── Private helpers ───────────────────────────────────────────────────────

  private validateToken(token: string): void {
    const secret = this.configService.get<string>('whatsapp.qrToken');
    if (!secret || token !== secret) {
      throw new UnauthorizedException('Invalid token');
    }
  }

  private buildHtml(token: string): string {
    const { isConnected, qrDataUrl, qrIsValid, qrSecondsRemaining } =
      this.whatsappService;

    const initialState: 'connected' | 'qr_valid' | 'qr_expired' | 'generating' =
      isConnected
        ? 'connected'
        : qrDataUrl && qrIsValid
          ? 'qr_valid'
          : qrDataUrl && !qrIsValid
            ? 'qr_expired'
            : 'generating';

    const initialStatusClass =
      initialState === 'connected' ? 'connected' :
      initialState === 'qr_valid'  ? 'scanning'  :
      initialState === 'qr_expired'? 'expired'   : 'waiting';

    const initialStatusText =
      initialState === 'connected'  ? '✅ Connected'            :
      initialState === 'qr_valid'   ? '📷 Ready to scan'        :
      initialState === 'qr_expired' ? '⏰ QR expired — hold on' :
                                      '⏳ Generating QR…';

    const initialQrHtml = isConnected
      ? `<p class="state-message success">WhatsApp is connected.<br>No QR code needed.</p>`
      : qrDataUrl && qrIsValid
        ? `<img src="${qrDataUrl}" alt="WhatsApp QR Code" id="qr-img">
           <div class="countdown-wrap">
             <div class="countdown-ring">
               <svg viewBox="0 0 36 36" width="36" height="36">
                 <circle class="track" cx="18" cy="18" r="15.9"/>
                 <circle class="fill" cx="18" cy="18" r="15.9"
                   id="ring-fill" stroke="#3b82f6"
                   stroke-dasharray="100"
                   stroke-dashoffset="${100 - Math.round((qrSecondsRemaining / 18) * 100)}"/>
               </svg>
             </div>
             <span class="countdown-label">Expires in <span id="countdown">${qrSecondsRemaining}s</span></span>
           </div>`
        : qrDataUrl
          ? `<img src="${qrDataUrl}" alt="Expired QR" id="qr-img" class="faded">
             <div class="expired-overlay">⏰ New QR incoming…</div>`
          : `<p class="state-message">Generating QR code…<br>usually a few seconds.</p>`;

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
      transition: all .3s ease;
    }
    .status-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
    .status.connected  { color:#15803d; background:#f0fdf4; border:1px solid #bbf7d0; }
    .status.connected  .status-dot { background:#22c55e; box-shadow:0 0 0 2px #dcfce7; }
    .status.scanning   { color:#1d4ed8; background:#eff6ff; border:1px solid #bfdbfe; }
    .status.scanning   .status-dot { background:#3b82f6; animation:pulse 1.2s infinite; }
    .status.expired    { color:#dc2626; background:#fef2f2; border:1px solid #fecaca; }
    .status.expired    .status-dot { background:#ef4444; }
    .status.waiting    { color:#92400e; background:#fffbeb; border:1px solid #fde68a; }
    .status.waiting    .status-dot { background:#f59e0b; animation:pulse 1.5s infinite; }
    @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.3} }
    .qr-wrap {
      min-height: 230px;
      display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      margin-bottom: 1.5rem; position: relative;
    }
    .qr-wrap img {
      border-radius: 12px;
      box-shadow: 0 2px 16px rgba(0,0,0,.1);
      max-width: 260px; width: 100%;
      transition: opacity .3s ease, filter .3s ease;
    }
    .qr-wrap img.faded { opacity: .2; filter: blur(3px); }
    .expired-overlay {
      position: absolute; top: 50%; left: 50%;
      transform: translate(-50%,-50%);
      background: rgba(255,255,255,.93);
      border: 1.5px solid #fca5a5; border-radius: 10px;
      padding: .6rem 1rem; font-size: .85rem; font-weight: 600;
      color: #dc2626; backdrop-filter: blur(2px);
      white-space: nowrap;
    }
    .countdown-wrap {
      margin-top: .75rem;
      display: flex; align-items: center; justify-content: center; gap: .5rem;
    }
    .countdown-ring { width: 36px; height: 36px; flex-shrink: 0; }
    .countdown-ring svg { transform: rotate(-90deg); }
    .countdown-ring .track { fill: none; stroke: #e2e8f0; stroke-width: 3; }
    .countdown-ring .fill  {
      fill: none; stroke-width: 3; stroke-linecap: round;
      transition: stroke-dashoffset 1s linear, stroke .5s ease;
    }
    .countdown-label { font-size: .8rem; font-weight: 600; color: #475569; }
    .countdown-label span { color: #0f172a; font-size: .9rem; }
    .state-message { font-size: .9rem; color: #64748b; line-height: 1.6; }
    .state-message.success { color: #15803d; font-weight: 600; font-size: 1rem; }
    .instructions {
      font-size: .775rem; color: #94a3b8; line-height: 1.7;
      border-top: 1px solid #f1f5f9; padding-top: 1rem;
    }
    .instructions strong { color: #64748b; }
    .step { display: flex; align-items: flex-start; gap: .5rem; text-align: left; margin-top: .4rem; }
    .step-num {
      min-width: 18px; height: 18px; background: #e2e8f0; border-radius: 50%;
      font-size: .7rem; font-weight: 700; color: #475569;
      display: flex; align-items: center; justify-content: center;
      flex-shrink: 0; margin-top: 1px;
    }
    .debug-bar {
      margin-top: 1rem; padding: .5rem; background: #f8fafc;
      border-radius: 8px; font-size: .7rem; color: #94a3b8;
      font-family: monospace;
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

  <div class="status ${initialStatusClass}" id="status-pill">
    <span class="status-dot"></span>
    <span id="status-text">${initialStatusText}</span>
  </div>

  <div class="qr-wrap" id="qr-wrap">${initialQrHtml}</div>

  <div class="instructions" id="instructions"${isConnected ? ' style="display:none"' : ''}>
    <strong>How to scan:</strong>
    <div class="step"><span class="step-num">1</span><span>Open WhatsApp on your phone</span></div>
    <div class="step"><span class="step-num">2</span><span>Tap ⋮ (Android) or Settings (iOS) → Linked Devices</span></div>
    <div class="step"><span class="step-num">3</span><span>Tap <strong>Link a Device</strong></span></div>
    <div class="step"><span class="step-num">4</span><span>Point your camera at the QR code — you have ~18 seconds</span></div>
  </div>

  <div class="debug-bar" id="debug-bar">transport: initializing…</div>
</div>

<script>
(function () {
  'use strict';

  var TOKEN = ${JSON.stringify(token)};
  var lastQrDataUrl = ${JSON.stringify(qrDataUrl ?? null)};
  var countdownTimer = null;
  var sseOk = false;

  var statusPill = document.getElementById('status-pill');
  var statusText = document.getElementById('status-text');
  var qrWrap     = document.getElementById('qr-wrap');
  var instrBox   = document.getElementById('instructions');
  var debugBar   = document.getElementById('debug-bar');

  // ── Try SSE first, fall back to polling if it stalls ──────────────────────
  var sseStallTimer = setTimeout(function () {
    if (!sseOk) {
      debugBar.textContent = 'transport: SSE stalled (Cloudflare?) → polling every 2s';
      startPolling();
    }
  }, 4000); // if no SSE message within 4s, switch to polling

  try {
    var evtSource = new EventSource('/qr/events?token=' + TOKEN);

    evtSource.onmessage = function (e) {
      if (!sseOk) {
        sseOk = true;
        clearTimeout(sseStallTimer);
        debugBar.textContent = 'transport: SSE ✓';
      }
      var data = JSON.parse(e.data);
      render(data);
    };

    evtSource.onerror = function () {
      if (!sseOk) {
        clearTimeout(sseStallTimer);
        debugBar.textContent = 'transport: SSE failed → polling every 2s';
        evtSource.close();
        startPolling();
      }
    };
  } catch (err) {
    clearTimeout(sseStallTimer);
    debugBar.textContent = 'transport: SSE unavailable → polling every 2s';
    startPolling();
  }

  // ── Polling fallback ───────────────────────────────────────────────────────
  var pollTimer = null;
  function startPolling() {
    if (pollTimer) return; // already polling
    poll(); // immediate first poll
    pollTimer = setInterval(poll, 2000);
  }

  function poll() {
    fetch('/qr/state?token=' + TOKEN)
      .then(function (r) { return r.json(); })
      .then(function (data) { render(data); })
      .catch(function () {});
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  function render(data) {
    if (data.isConnected) {
      renderConnected();
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      return;
    }
    if (data.qrDataUrl && data.qrIsValid) {
      if (data.qrDataUrl !== lastQrDataUrl) {
        lastQrDataUrl = data.qrDataUrl;
        renderQr(data.qrDataUrl, data.qrSecondsRemaining);
      } else {
        updateCountdown(data.qrSecondsRemaining);
      }
    } else if (data.qrDataUrl && !data.qrIsValid) {
      renderExpired(data.qrDataUrl);
    } else {
      renderGenerating();
    }
  }

  function renderConnected() {
    setStatus('connected', '✅ Connected');
    qrWrap.innerHTML = '<p class="state-message success">WhatsApp is connected.<br>No QR code needed.</p>';
    instrBox.style.display = 'none';
    clearCountdown();
  }

  function renderQr(dataUrl, seconds) {
    clearCountdown();
    setStatus('scanning', '📷 Ready to scan');
    qrWrap.innerHTML =
      '<img src="' + dataUrl + '" alt="WhatsApp QR Code" id="qr-img">' +
      '<div class="countdown-wrap">' +
        '<div class="countdown-ring">' +
          '<svg viewBox="0 0 36 36" width="36" height="36">' +
            '<circle class="track" cx="18" cy="18" r="15.9"/>' +
            '<circle class="fill" cx="18" cy="18" r="15.9"' +
              ' id="ring-fill" stroke="#3b82f6" stroke-dasharray="100"' +
              ' stroke-dashoffset="' + (100 - Math.round((seconds / 18) * 100)) + '"/>' +
          '</svg>' +
        '</div>' +
        '<span class="countdown-label">Expires in <span id="countdown">' + seconds + 's</span></span>' +
      '</div>';
    instrBox.style.display = '';
    startCountdown(seconds);
  }

  function renderExpired(dataUrl) {
    clearCountdown();
    setStatus('expired', '⏰ QR expired — new one incoming');
    qrWrap.innerHTML =
      '<img src="' + dataUrl + '" alt="Expired QR" id="qr-img" class="faded">' +
      '<div class="expired-overlay">⏰ New QR incoming…</div>';
  }

  function renderGenerating() {
    clearCountdown();
    setStatus('waiting', '⏳ Generating QR…');
    qrWrap.innerHTML = '<p class="state-message">Generating QR code…<br>usually a few seconds.</p>';
    instrBox.style.display = '';
  }

  // ── Countdown ──────────────────────────────────────────────────────────────
  function startCountdown(seconds) {
    var s = seconds;
    countdownTimer = setInterval(function () {
      s--;
      updateCountdown(s);
      if (s <= 0) clearCountdown();
    }, 1000);
  }

  function updateCountdown(s) {
    var el   = document.getElementById('countdown');
    var ring = document.getElementById('ring-fill');
    if (el)   el.textContent = s + 's';
    if (ring) {
      var pct = Math.max(0, Math.round((s / 18) * 100));
      ring.setAttribute('stroke-dashoffset', String(100 - pct));
      ring.setAttribute('stroke', s > 8 ? '#3b82f6' : s > 4 ? '#f59e0b' : '#ef4444');
    }
  }

  function clearCountdown() {
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
  }

  // ── Status ─────────────────────────────────────────────────────────────────
  function setStatus(cls, text) {
    statusPill.className = 'status ' + cls;
    statusText.textContent = text;
  }
}());
</script>
</body>
</html>`;
  }
}