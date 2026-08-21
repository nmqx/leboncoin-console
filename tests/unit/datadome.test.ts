import { describe, it, expect } from "vitest";
import { classifyDataDome } from "../../apps/server/src/adapters/leboncoin/datadome.js";

const base = { status: 403, url: "https://www.leboncoin.fr/recherche" };

describe("classification DataDome", () => {
  it("rt=i → interstitial + DataDomeInterstitialCookie", () => {
    const url = "https://geo.captcha-delivery.com/captcha/?initialCid=abc&rt=i&cid=xyz";
    const c = classifyDataDome({ ...base, body: `<script src="${url}"></script>` });
    expect(c?.kind).toBe("interstitial");
    expect(c?.cookieName).toBe("DataDomeInterstitialCookie");
    expect(c?.captchaUrl).toBe(url);
  });

  it("rt=c → slider + DataDomeSliderCookie", () => {
    const c = classifyDataDome({
      ...base,
      url: "https://geo.captcha-delivery.com/captcha/?rt=c&hash=1",
    });
    expect(c?.kind).toBe("slider");
    expect(c?.cookieName).toBe("DataDomeSliderCookie");
  });

  it("t=bv → abandon immédiat (IP grillée)", () => {
    const c = classifyDataDome({
      ...base,
      url: "https://geo.captcha-delivery.com/captcha/?t=bv&metabgclr=transparent",
    });
    expect(c?.kind).toBe("abandon");
    expect(c?.cookieName).toBeNull();
    expect(c?.reason).toMatch(/rotation/);
  });

  it("paramètres inconnus → abandon prudent, jamais une liste vide", () => {
    const c = classifyDataDome({ ...base, body: "<html>403</html>" });
    expect(c?.kind).toBe("abandon");
    expect(c?.reason).toMatch(/inconnu/);
  });

  it("un non-403 n'est pas un challenge", () => {
    expect(classifyDataDome({ status: 200, url: base.url, body: "ok" })).toBeNull();
    expect(classifyDataDome({ status: 429, url: base.url })).toBeNull();
  });

  it("l'URL captcha peut vivre dans le corps minifié", () => {
    const c = classifyDataDome({
      ...base,
      body: `var dd={u:"https://geo.captcha-delivery.com/captcha/?initialCid=1&rt=i&cid=2&e=SHA"}`,
    });
    expect(c?.kind).toBe("interstitial");
  });
});
