import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { sessionApi, type Session } from '../services/api';
import { isValidPairingPhone } from '../utils/sessionForm';

export interface QrData {
  sessionId: string;
  sessionName: string;
  qrCode: string;
}

export interface UseSessionPairingArgs {
  sessions: Session[];
  reloadSessions: () => Promise<Session[]>;
  /** Apply a single session row from GET /sessions/:id — avoids list refetch (often 429 while pairing). */
  applySessionPatch: (session: Session) => void;
  onPairingReady?: (sessionId: string) => void;
}

export interface SessionPairing {
  qrData: QrData | null;
  pairingMode: boolean;
  phoneNumber: string;
  pairingCode: string | null;
  requestingPairing: boolean;
  pairingError: string | null;
  setPhoneNumber: (value: string) => void;
  selectPairingTab: (mode: boolean) => void;
  handleChangeNumber: () => void;
  handleGeneratePairingCode: () => Promise<void>;
  handleShowQR: (id: string) => Promise<void>;
  handleCloseQRModal: () => void;
  applyQrPush: (event: { sessionId: string; qrCode: string }) => void;
  dismissQrForSession: (sessionId: string, onlyIfBlank?: boolean) => void;
  clearQrCodeForSession: (sessionId: string) => void;
}

const STATUS_POLL_MS = 4000;
/** WhatsApp rotates QR about every 20s; WS pushes cover most refreshes — REST QR fetch stays sparse. */
const QR_IMAGE_REFRESH_MS = 22_000;
const RATE_LIMIT_BACKOFF_MS = 60_000;

function isTooManyRequests(err: unknown): boolean {
  return err instanceof Error && (err as Error & { status?: number }).status === 429;
}

/**
 * Owns the QR / pairing-code modal: the six state vars behind it, the poll-while-open effect, and
 * the handlers that drive it. `phoneNumber`/`pairingCode`/`pairingError` live HERE rather than in an
 * extracted panel component, because the panel renders only while `pairingMode` is true — a
 * component that unmounts on every QR<->Phone tab toggle would discard whatever the operator had
 * typed. `Sessions.test.ts` pins this exact case.
 *
 * `applyQrPush` and `dismissQrForSession` are both `useCallback(…, [])` built on the FUNCTIONAL
 * `setQrData` form: reading `qrData` directly would make each a dependency of `applySessionResponse`
 * (held by the page's stop/force-kill/unlink handlers), rotating its identity for a reason none of
 * those callers care about.
 */
export function useSessionPairing({
  sessions,
  reloadSessions,
  applySessionPatch,
  onPairingReady,
}: UseSessionPairingArgs): SessionPairing {
  const { t } = useTranslation();
  const [qrData, setQrData] = useState<QrData | null>(null);
  const [pairingMode, setPairingMode] = useState(false);
  const [phoneNumber, setPhoneNumber] = useState('');
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [requestingPairing, setRequestingPairing] = useState(false);
  const [pairingError, setPairingError] = useState<string | null>(null);

  const qrRefreshInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  // Bumped whenever the modal opens, closes or is dismissed. A pairing-code request is not cancelled
  // by any of those, so its answer is applied only while the modal it was sent from is still the one
  // on screen: not in a modal since opened for another session, nor in the same session's modal reset
  // to a blank form.
  const pairingGen = useRef(0);
  const pollBackoffUntil = useRef(0);
  const pollInFlight = useRef(false);
  const lastQrFetchAt = useRef(0);
  const qrCodePresent = useRef(false);

  useEffect(() => {
    qrCodePresent.current = Boolean(qrData?.qrCode);
  }, [qrData?.qrCode]);

  const fetchQR = useCallback(
    async (sessionId: string) => {
      if (Date.now() < pollBackoffUntil.current) return;
      if (pollInFlight.current) return;
      pollInFlight.current = true;
      try {
        // Re-read status while the modal is open (WebSocket may be down in dev). One GET per tick —
        // avoid pairing it with getQR every few seconds or the API throttler (10 req/s) trips.
        let serverSession: Session;
        try {
          serverSession = await sessionApi.get(sessionId);
        } catch (err) {
          if (isTooManyRequests(err)) {
            pollBackoffUntil.current = Date.now() + RATE_LIMIT_BACKOFF_MS;
            setPairingError(t('sessions.qr.rateLimited'));
          }
          return;
        }

        applySessionPatch(serverSession);

        if (serverSession.status === 'ready') {
          setQrData(cur => (cur?.sessionId === sessionId ? null : cur));
          setPairingError(null);
          onPairingReady?.(sessionId);
          void reloadSessions();
          return;
        }
        if (serverSession.status === 'failed') {
          setQrData(cur => (cur?.sessionId === sessionId ? null : cur));
          setPairingError(null);
          void reloadSessions();
          return;
        }

        if (serverSession.status === 'authenticating') {
          setPairingError(null);
          return;
        }

        if (serverSession.status !== 'qr_ready') return;

        const needQrImage =
          !qrCodePresent.current || Date.now() - lastQrFetchAt.current >= QR_IMAGE_REFRESH_MS;
        if (!needQrImage) return;

        try {
          const qr = await sessionApi.getQR(sessionId);
          lastQrFetchAt.current = Date.now();
          setPairingError(null);
          setQrData(cur => (cur?.sessionId === sessionId ? { ...cur, qrCode: qr.qrCode } : cur));
          if (qr.status === 'ready') {
            setQrData(cur => (cur?.sessionId === sessionId ? null : cur));
            onPairingReady?.(sessionId);
            void reloadSessions();
          }
        } catch (err) {
          if (isTooManyRequests(err)) {
            pollBackoffUntil.current = Date.now() + RATE_LIMIT_BACKOFF_MS;
            setPairingError(t('sessions.qr.rateLimited'));
            return;
          }
          const stillInitializing = ['initializing', 'qr_ready', 'authenticating'].includes(serverSession.status);
          if (!stillInitializing) {
            setQrData(cur => (cur?.sessionId === sessionId ? null : cur));
            void reloadSessions();
          }
        }
      } finally {
        pollInFlight.current = false;
      }
    },
    [reloadSessions, applySessionPatch, onPairingReady, t],
  );

  useEffect(() => {
    if (qrData) {
      const sessionId = qrData.sessionId;
      const tick = () => void fetchQR(sessionId);
      const startDelay = window.setTimeout(tick, 800);
      qrRefreshInterval.current = setInterval(tick, STATUS_POLL_MS);
      return () => {
        window.clearTimeout(startDelay);
        if (qrRefreshInterval.current) clearInterval(qrRefreshInterval.current);
      };
    }
    return () => {
      if (qrRefreshInterval.current) clearInterval(qrRefreshInterval.current);
    };
  }, [qrData?.sessionId, fetchQR]);

  const handleCloseQRModal = useCallback(() => {
    pairingGen.current += 1;
    setRequestingPairing(false);
    setPairingError(null);
    pollBackoffUntil.current = 0;
    setQrData(null);
    setPairingMode(false);
    setPhoneNumber('');
    setPairingCode(null);
    setPairingError(null);
  }, []);

  // Shared by both pairing tabs: switching tabs always clears a stale error from the other tab.
  const selectPairingTab = useCallback((mode: boolean) => {
    setPairingMode(mode);
    setPairingError(null);
  }, []);

  const handleChangeNumber = useCallback(() => {
    setPairingCode(null);
    setPhoneNumber('');
  }, []);

  const handleGeneratePairingCode = async () => {
    // Guard against a second concurrent request: the button is disabled while in flight, but the
    // input's Enter handler is not, so a rapid double-Enter would otherwise fire overlapping POSTs.
    if (requestingPairing) return;
    if (!qrData || !phoneNumber.trim()) return;
    if (!isValidPairingPhone(phoneNumber)) {
      setPairingError(t('sessions.pairing.invalidPhone'));
      return;
    }
    const gen = pairingGen.current;
    try {
      setRequestingPairing(true);
      setPairingError(null);
      const res = await sessionApi.requestPairingCode(qrData.sessionId, phoneNumber.trim());
      if (gen === pairingGen.current) setPairingCode(res.pairingCode);
    } catch (err) {
      if (gen === pairingGen.current) setPairingError(err instanceof Error ? err.message : t('common.errorGeneric'));
    } finally {
      if (gen === pairingGen.current) setRequestingPairing(false);
    }
  };

  const handleShowQR = async (id: string) => {
    const session = sessions.find(s => s.id === id);
    // Nothing to show for an already-connected session.
    if (session?.status === 'ready') return;
    const sessionName = session?.name || '';
    // Reset any pairing sub-state from a previous open so a freshly opened modal never shows a
    // stale code/phone belonging to a different session.
    pairingGen.current += 1;
    setPairingMode(false);
    setPhoneNumber('');
    setPairingCode(null);
    setPairingError(null);
    setRequestingPairing(false);
    pollBackoffUntil.current = 0;
    lastQrFetchAt.current = 0;
    // Show loading state immediately; the poll loop + WS `session.qr` fetch the image (no duplicate
    // eager getQR here — that doubled traffic and tripped the API throttler).
    setQrData({ sessionId: id, sessionName, qrCode: '' });
  };

  // Fill the open QR modal straight from the push — the REST endpoint 400s BY DESIGN until a QR
  // exists, so fetching it eagerly just spams the console with expected failures.
  const applyQrPush = useCallback((event: { sessionId: string; qrCode: string }) => {
    setQrData(prev => (prev && prev.sessionId === event.sessionId ? { ...prev, qrCode: event.qrCode } : prev));
  }, []);

  // Clear the modal when the session that owned it stops, so it never hangs on a disconnected
  // session's stale code. Functional form deliberately: reading `qrData` here would make it a
  // dependency everywhere this is held (the page's stop/force-kill/unlink handlers).
  //
  // `onlyIfBlank` is for the one caller that decides asynchronously: the disconnect handler blanks
  // the code, asks the server whether an engine is still registered, and closes the modal on the
  // answer. A reconnect can complete inside that window and push a fresh code, and closing then
  // would throw away a code that works. The guard proves only that the modal is blank right now,
  // not that it is still the same modal that was blanked. That is enough: the only other way to be
  // blank is a modal still loading its first code, for a session the answer just said has no engine,
  // and closing that one is right too. A code arriving AFTER the answer is not covered, and cannot
  // be from here; the modal is gone by then and the operator reopens it from the card.
  const dismissQrForSession = useCallback((sessionId: string, onlyIfBlank = false) => {
    setQrData(current => {
      if (current?.sessionId !== sessionId) return current;
      if (onlyIfBlank && current.qrCode) return current;
      pairingGen.current += 1;
      return null;
    });
  }, []);

  // Blank the displayed code while keeping the modal open, for a disconnect whose engine is still
  // registered (an engine-internal reconnect): the code on screen was minted by a connection that is
  // now gone, so scanning it cannot work. The modal falls back to its loading state, and the poll
  // fills it again once the session is back at `qr_ready` with a fresh code.
  const clearQrCodeForSession = useCallback((sessionId: string) => {
    setQrData(current => (current?.sessionId === sessionId ? { ...current, qrCode: '' } : current));
  }, []);

  return {
    qrData,
    pairingMode,
    phoneNumber,
    pairingCode,
    requestingPairing,
    pairingError,
    setPhoneNumber,
    selectPairingTab,
    handleChangeNumber,
    handleGeneratePairingCode,
    handleShowQR,
    handleCloseQRModal,
    applyQrPush,
    dismissQrForSession,
    clearQrCodeForSession,
  };
}
