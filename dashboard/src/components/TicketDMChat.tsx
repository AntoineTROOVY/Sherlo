import { useEffect } from 'react';

const TICKETDM_SCRIPT_SRC = 'https://ticketdm.com/w.js';
const TICKETDM_PUBLIC_KEY = 'pk_live_bv36epc8y7nuv6b3';
const SCRIPT_ID = 'ticketdm-script';

declare global {
  interface Window {
    TicketDM?: { close?: () => void };
  }
}

/** Loads the TicketDM chat widget (fixed bottom-right by TicketDM). Mount once at the app root so it shows on every page, login included. */
export function TicketDMChat() {
  useEffect(() => {
    if (document.getElementById(SCRIPT_ID)) return;

    const script = document.createElement('script');
    script.id = SCRIPT_ID;
    script.async = true;
    script.src = TICKETDM_SCRIPT_SRC;
    script.setAttribute('data-key', TICKETDM_PUBLIC_KEY);
    script.setAttribute('data-cfasync', 'false');
    document.body.appendChild(script);

    return () => {
      // The widget exposes no hide(): close the panel if this component ever unmounts.
      window.TicketDM?.close?.();
    };
  }, []);

  return null;
}
