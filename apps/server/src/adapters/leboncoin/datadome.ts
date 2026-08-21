/**
 * Classification des challenges DataDome d'après une réponse 403.
 *
 *   interstitial → geo.captcha-delivery.com/interstitial/ (rt=i, t=it)
 *   slider       → captcha-delivery …/captcha/ avec rt=c
 *   t=bv         → abandon immédiat, changement d'IP (IP grillée)
 *   inconnu      → abandon prudent
 *
 * Un 403 n'est jamais une liste vide : il sort de cette fonction avec un plan.
 */
export type DataDomeKind = "interstitial" | "slider" | "abandon";

export interface DataDomeChallenge {
  kind: DataDomeKind;
  cookieName: "DataDomeInterstitialCookie" | "DataDomeSliderCookie" | null;
  captchaUrl: string | null;
  reason: string;
}

export interface HttpResponseLike {
  status: number;
  url: string;
  body?: string;
}

const CAPTCHA_URL_RE = /https?:\/\/[a-z0-9.-]*captcha-delivery\.com\/[a-z/]+\?[^"'\\\s]+/i;

export function classifyDataDome(res: HttpResponseLike): DataDomeChallenge | null {
  if (res.status !== 403) return null;

  const captchaUrl = extractCaptchaUrl(res);
  const params = captchaUrl ? parseQuery(captchaUrl) : parseQuery(res.url);

  const rt = params["rt"];
  const t = params["t"];
  const path = captchaUrl ?? "";

  if (t === "bv") {
    return {
      kind: "abandon",
      cookieName: null,
      captchaUrl,
      reason: "t=bv : IP marquée, abandon et rotation d'IP requises",
    };
  }
  if (rt === "i" || t === "it" || /\/interstitial\//i.test(path)) {
    return {
      kind: "interstitial",
      cookieName: "DataDomeInterstitialCookie",
      captchaUrl,
      reason: `interstitial (rt=${rt ?? "—"}, t=${t ?? "—"})`,
    };
  }
  if (rt === "c" || t === "c" || /slider/i.test(path)) {
    return {
      kind: "slider",
      cookieName: "DataDomeSliderCookie",
      captchaUrl,
      reason: `slider (rt=${rt ?? "—"}, t=${t ?? "—"})`,
    };
  }
  return {
    kind: "abandon",
    cookieName: null,
    captchaUrl,
    reason: `challenge inconnu (rt=${rt ?? "absent"}, t=${t ?? "absent"}) — abandon prudent`,
  };
}

function extractCaptchaUrl(res: HttpResponseLike): string | null {
  if (res.body) {
    const m = res.body.match(CAPTCHA_URL_RE);
    if (m) return m[0];
    // corps JSON {"url":"https://geo.captcha-delivery.com/…"}
    const jm = res.body.match(/"url"\s*:\s*"(https:[^"]*captcha-delivery[^"]*)"/i);
    if (jm?.[1]) return jm[1].replace(/\\\//g, "/");
  }
  if (/captcha-delivery\.com/i.test(res.url)) return res.url;
  return null;
}

function parseQuery(url: string): Record<string, string> {
  const out: Record<string, string> = {};
  const q = url.split("?")[1];
  if (!q) return out;
  for (const pair of q.split("&")) {
    const [k, v] = pair.split("=");
    if (k) out[decodeURIComponent(k)] = decodeURIComponent(v ?? "");
  }
  return out;
}
