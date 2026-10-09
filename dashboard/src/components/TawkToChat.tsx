import { useEffect } from 'react';

const TAWK_EMBED_SRC = 'https://embed.tawk.to/6ac8277820f8c634c504cfa1/1k4etkbtu';
const SCRIPT_ID = 'tawk-to-script';

declare global {
  interface Window {
    Tawk_API?: { hideWidget?: () => void; onLoad?: () => void };
    Tawk_LoadStart?: Date;
  }
}

/** Loads the Tawk.to widget (fixed bottom-right by Tawk). Mount once while the user is in the app. */
export function TawkToChat() {
  useEffect(() => {
    if (document.getElementById(SCRIPT_ID)) return;

    window.Tawk_API = window.Tawk_API ?? {};
    window.Tawk_LoadStart = new Date();

    const script = document.createElement('script');
    script.id = SCRIPT_ID;
    script.async = true;
    script.src = TAWK_EMBED_SRC;
    script.charset = 'UTF-8';
    script.setAttribute('crossorigin', '*');

    const anchor = document.getElementsByTagName('script')[0];
    anchor?.parentNode?.insertBefore(script, anchor);

    return () => {
      window.Tawk_API?.hideWidget?.();
    };
  }, []);

  return null;
}
