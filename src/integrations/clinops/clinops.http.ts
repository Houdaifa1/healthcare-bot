import {
  Injectable,
  Logger,
  BadRequestException,
  ServiceUnavailableException,
  GatewayTimeoutException,
  UnauthorizedException,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance, AxiosError, Method } from 'axios';

/**
 * Transport for the real ClinOps external API.
 *
 * Contract source of truth: docs/clinops-api-external.html. Every path, field
 * name, HTTP method and error message below is taken from that document —
 * nothing here is inferred from the mock fixtures.
 *
 * Two things about that contract are unusual and deliberate:
 *
 *  1. Every read endpoint is documented as **GET with a JSON request body**
 *     (getSpeciality is the only one with no body at all). That is not a typo
 *     in this client: it mirrors the doc. axios sends `data` on GET happily.
 *  2. Every response is wrapped in `{ "success": boolean, ... }`. A 200 whose
 *     body has `success !== true` is treated as a failure, not as data.
 */

/** `{ success, data }` — getSpeciality, getDoctorsBySpeciality, searchPatientsInfos, … */
export interface ClinOpsEnvelope<T> {
  success: boolean;
  data?: T;
  message?: string;
  error?: string;
}

interface ClinOpsTokenResponse {
  success: boolean;
  token?: string;
  message?: string;
  error?: string;
}

/**
 * Injection token for the live transport. It is a token rather than the class
 * itself because the provider resolves to `null` in mock mode, and Nest needs
 * a name it can bind that null to.
 */
export const CLINOPS_HTTP = 'CLINOPS_HTTP';

@Injectable()
export class ClinOpsHttpClient {
  private readonly logger = new Logger(ClinOpsHttpClient.name);

  private readonly http: AxiosInstance;
  private readonly username: string;
  private readonly password: string;
  private readonly tokenTtlMs: number;

  /** Cached bearer token and the moment it stops being reused. */
  private token: string | null = null;
  private tokenExpiresAt = 0;

  /**
   * In-flight token request, shared by every caller that needs one while it is
   * running. getAccesAutorisation is rate limited to 5 requests per minute
   * (per the doc), so a burst of parallel calls must not each mint their own.
   */
  private tokenInFlight: Promise<string> | null = null;

  constructor(configService: ConfigService) {
    const baseURL = configService.getOrThrow<string>('clinops.baseUrl');
    this.username = configService.getOrThrow<string>('clinops.username');
    this.password = configService.getOrThrow<string>('clinops.password');
    const timeout = configService.get<number>('clinops.timeoutMs', 15_000);
    this.tokenTtlMs = configService.get<number>('clinops.tokenTtlMs', 900_000);

    this.http = axios.create({
      baseURL,
      timeout,
      headers: { 'Content-Type': 'application/json' },
      // Status handling is done explicitly in `request()` so upstream error
      // messages survive instead of being flattened into "Request failed".
      validateStatus: () => true,
    });

    this.logger.log(
      `ClinOps live transport ready — ${baseURL} (timeout ${timeout}ms)`,
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Authentication — POST getAccesAutorisation
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Returns a usable bearer token, minting one only when the cached token is
   * missing or past its local TTL.
   *
   * The doc does not publish the token's real lifetime, so this deliberately
   * does not pretend to know it: the TTL below is a local reuse budget
   * (CLINOPS_TOKEN_TTL_MS), and the authoritative expiry signal is a 401 from
   * a data endpoint, which `request()` handles by forcing exactly one refresh
   * and retry.
   */
  private async getToken(forceRefresh = false): Promise<string> {
    if (!forceRefresh && this.token && Date.now() < this.tokenExpiresAt) {
      return this.token;
    }
    if (this.tokenInFlight) return this.tokenInFlight;

    this.tokenInFlight = this.mintToken()
      .then((token) => {
        this.token = token;
        this.tokenExpiresAt = Date.now() + this.tokenTtlMs;
        return token;
      })
      .finally(() => {
        this.tokenInFlight = null;
      });

    return this.tokenInFlight;
  }

  private async mintToken(): Promise<string> {
    let res;
    try {
      res = await this.http.request<ClinOpsTokenResponse>({
        method: 'post',
        url: '/getAccesAutorisation',
        data: { username: this.username, password: this.password },
      });
    } catch (err) {
      throw this.transportFailure('getAccesAutorisation', err);
    }

    const body = res.data ?? ({} as ClinOpsTokenResponse);

    if (res.status === 200 && body.success === true && body.token) {
      this.logger.log('ClinOps authentication succeeded');
      return body.token;
    }

    const detail = body.message ?? body.error ?? '';

    // Documented failure modes for this endpoint, kept distinct so an operator
    // can tell "wrong password" from "Keycloak is down".
    switch (res.status) {
      case 400:
        throw new BadRequestException(
          `ClinOps authentication rejected the request (400): ${detail || 'JSON invalide ou champs manquants'}`,
        );
      case 401:
        throw new UnauthorizedException(
          `ClinOps authentication failed (401): ${detail || 'Identifiants invalides'} — check CLINOPS_USERNAME / CLINOPS_PASSWORD`,
        );
      case 502:
        throw new ServiceUnavailableException(
          `ClinOps authentication misconfigured upstream (502): ${detail || 'Erreur de configuration Keycloak'}`,
        );
      case 503:
        throw new ServiceUnavailableException(
          `ClinOps authentication service unavailable (503): ${detail || "Service d'authentification indisponible"}`,
        );
      case 504:
        throw new GatewayTimeoutException(
          `ClinOps authentication timed out (504): ${detail || "Timeout du service d'authentification"}`,
        );
      default:
        throw new ServiceUnavailableException(
          `ClinOps authentication returned an unexpected response (${res.status}): ${detail || 'no message'}`,
        );
    }
  }

  /**
   * Drops the cached token. Used by the credential self-test so a check always
   * exercises a real round trip rather than a token minted minutes ago.
   */
  resetToken(): void {
    this.token = null;
    this.tokenExpiresAt = 0;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Generic authenticated request
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Calls one ClinOps endpoint and unwraps its `{ success, data }` envelope.
   *
   * `retryOn401` gives exactly one refresh-and-retry when the server rejects
   * the token, which is how an expired token surfaces (the doc publishes no
   * expiry). A second 401 is a real credential problem and is raised.
   */
  private async request<T>(
    method: Method,
    endpoint: string,
    body: Record<string, unknown> | undefined,
    unwrap: boolean,
    retryOn401 = true,
  ): Promise<T> {
    const token = await this.getToken();
    const startedAt = Date.now();

    let res;
    try {
      res = await this.http.request<ClinOpsEnvelope<T>>({
        method,
        url: `/${endpoint}`,
        data: body,
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (err) {
      throw this.transportFailure(endpoint, err);
    }

    const latencyMs = Date.now() - startedAt;
    const payload = res.data ?? ({} as ClinOpsEnvelope<T>);
    const detail = payload.message ?? payload.error ?? '';

    if (res.status === 401 && retryOn401 && method.toLowerCase() === 'get') {
      this.logger.warn(
        `ClinOps ${endpoint} returned 401 — refreshing token and retrying once`,
      );
      await this.getToken(true);
      return this.request<T>(method, endpoint, body, unwrap, false);
    }

    if (res.status === 200 && payload.success === true) {
      this.logger.log(`ClinOps ${endpoint} succeeded in ${latencyMs}ms`);
      // createNewRDV and createNewPatient answer `{ success, message, ... }`
      // with no `data` key at all, so those callers ask for the raw envelope.
      return (unwrap ? payload.data : payload) as T;
    }

    this.logger.error(
      `ClinOps ${endpoint} failed in ${latencyMs}ms (HTTP ${res.status}): ${detail || 'no message'}`,
    );

    // The API's own 400 messages are the useful ones ("specialite_id doit être
    // un entier", "Aucun médecin trouvé avec ce nom", …) and several callers
    // surface them to staff, so they are passed through verbatim.
    if (res.status === 400) {
      throw new BadRequestException(
        detail || `ClinOps ${endpoint}: requête invalide`,
      );
    }
    if (res.status === 401) {
      throw new UnauthorizedException(
        detail || `ClinOps ${endpoint}: token d'authentification invalide`,
      );
    }
    if (res.status >= 500) {
      // Upstream is broken, not the caller — never reported as a 500 of ours.
      throw new ServiceUnavailableException(
        `ClinOps ${endpoint} upstream error (${res.status}): ${detail || 'Erreur serveur interne'}`,
      );
    }
    if (res.status === 200) {
      // 200 with success:false — documented envelope, undocumented condition.
      throw new InternalServerErrorException(
        `ClinOps ${endpoint} reported success=false: ${detail || 'no message'}`,
      );
    }
    throw new ServiceUnavailableException(
      `ClinOps ${endpoint} returned an unexpected status ${res.status}: ${detail || 'no message'}`,
    );
  }

  /** Network-level failure (DNS, refused, TLS, client-side timeout). */
  private transportFailure(endpoint: string, err: unknown): Error {
    const axiosErr = err as AxiosError;
    if (axiosErr?.code === 'ECONNABORTED' || axiosErr?.code === 'ETIMEDOUT') {
      return new GatewayTimeoutException(
        `ClinOps ${endpoint} timed out — check CLINOPS_BASE_URL and CLINOPS_TIMEOUT_MS`,
      );
    }
    const reason =
      axiosErr?.code ?? (err instanceof Error ? err.message : String(err));
    return new ServiceUnavailableException(
      `ClinOps ${endpoint} is unreachable (${reason}) — check CLINOPS_BASE_URL and network access`,
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Endpoints — one method per documented route, same names as the doc
  // ═══════════════════════════════════════════════════════════════════════════

  /** GET an endpoint whose payload sits under `data`. */
  get<T>(endpoint: string, body?: Record<string, unknown>): Promise<T> {
    return this.request<T>('get', endpoint, body, true);
  }

  /** POST an endpoint whose payload sits under `data`. */
  post<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
    return this.request<T>('post', endpoint, body, true);
  }

  /** POST an endpoint whose fields live on the envelope itself, not under `data`. */
  postEnvelope<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
    return this.request<T>('post', endpoint, body, false);
  }

  /**
   * Round-trips authentication plus one cheap read, so a caller can prove the
   * configured credentials and base URL actually work. Used by the startup
   * self-check in live mode.
   */
  async verifyCredentials(): Promise<number> {
    this.resetToken();
    const specialties = await this.get<unknown[]>('getSpeciality');
    return Array.isArray(specialties) ? specialties.length : 0;
  }
}
