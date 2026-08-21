import { launchChromeDebug, CdpClient, pickLbcTarget } from "./apps/server/src/adapters/chrome/cdp.ts";
const handle = await launchChromeDebug({
  profileDir: "C:/Users/admin/Documents/leboncoin/data/chrome-profile",
  startUrl: "https://www.leboncoin.fr/recherche?text=iphone%2013&sort=date&order=desc",
});
async function firstIds(page, url) {
  await page.send("Page.navigate", { url });
  await new Promise(r => setTimeout(r, 8000));
  const res = await page.send("Runtime.evaluate", {
    expression: `[...document.querySelectorAll('a[href*="/ad/"]')].slice(0,8).map(a => (a.href.match(/\/ad\/([^/?]+)/)||[])[1]).join(',')`,
    returnByValue: true,
  });
  return String(res.result?.value ?? "").split(",").filter(Boolean);
}
try {
  await new Promise(r => setTimeout(r, 10000));
  const target = await pickLbcTarget(handle.port);
  const page = await CdpClient.connect(target.webSocketDebuggerUrl);
  await page.send("Page.enable");
  const p1 = await firstIds(page, "https://www.leboncoin.fr/recherche?text=iphone%2013&sort=date&order=desc");
  const p2 = await firstIds(page, "https://www.leboncoin.fr/recherche?text=iphone%2013&sort=date&order=desc&o=2");
  const p3 = await firstIds(page, "https://www.leboncoin.fr/recherche?text=iphone%2013&sort=date&order=desc&o=3");
  console.log("p1:", p1.slice(0,4).join(" "));
  console.log("p2:", p2.slice(0,4).join(" "));
  console.log("p3:", p3.slice(0,4).join(" "));
  console.log("p1∩p2:", p1.filter(x => p2.includes(x)).length, "/", p1.length, "| p1∩p3:", p1.filter(x => p3.includes(x)).length);
  // lien de pagination du site ?
  const pag = await page.send("Runtime.evaluate", { expression: `[...document.querySelectorAll('a,button')].filter(e => /page|suivant|next|›|»/i.test(e.textContent||'') && (e.textContent||'').trim().length < 25).slice(0,6).map(e => e.tagName + ':' + (e.textContent||'').trim() + ':' + (e.href||'')).join(' || ')`, returnByValue: true });
  console.log("contrôles pagination:", String(pag.result?.value ?? "").slice(0, 300));
  await page.close();
} finally {
  try { await (await CdpClient.connect(handle.browserWsUrl)).send("Browser.close"); } catch {}
  await new Promise(r => setTimeout(r, 1200));
  try { handle.process.kill(); } catch {}
}
