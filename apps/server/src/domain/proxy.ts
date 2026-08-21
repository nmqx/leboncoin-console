import { badRequest } from "../security/errors.js";

export interface ProxyConfig {
  type: "http";
  host: string;
  port: number;
  username: string;
  password: string;
}

/**
 * Accepte deux formats :
 *   user:pass@host:port   (ex. résidentiel : user-country-FR:pass@proxy.example.com:8080)
 *   host:port:user:pass
 * Le mot de passe ou l'utilisateur peuvent contenir ':' — on coupe par les bords,
 * jamais par un split naïf. Schéma http:// optionnel.
 */
export function parseProxy(raw: string): ProxyConfig {
  let s = raw.trim();
  if (!s) throw badRequest("Proxy vide");
  s = s.replace(/^https?:\/\//i, "");

  // Format user:pass@host:port si le segment après le dernier '@' est un
  // host:port propre — sinon l'@ appartient au mot de passe (host:port:user:pass).
  const at = s.lastIndexOf("@");
  if (at !== -1 && /^[a-z0-9.\-_]+:\d+$/i.test(s.slice(at + 1))) {
    const userPass = s.slice(0, at);
    const hostPort = s.slice(at + 1);
    const c1 = hostPort.indexOf(":");
    const host = hostPort.slice(0, c1);
    const port = Number(hostPort.slice(c1 + 1));
    const c2 = userPass.indexOf(":");
    if (c2 <= 0 || c2 === userPass.length - 1) {
      throw badRequest("Identifiants proxy attendus : user:pass");
    }
    return {
      type: "http",
      host,
      port,
      username: userPass.slice(0, c2),
      password: userPass.slice(c2 + 1),
    };
  }

  // host:port:user:pass — le reste après host:port est user:pass (peut contenir ':')
  const c1 = s.indexOf(":");
  if (c1 <= 0) {
    throw badRequest("Format proxy attendu : host:port:user:pass ou user:pass@host:port");
  }
  const host = s.slice(0, c1);
  const rest = s.slice(c1 + 1);
  const c2 = rest.indexOf(":");
  if (c2 <= 0 || c2 === rest.length - 1) {
    throw badRequest("Format proxy attendu : host:port:user:pass ou user:pass@host:port");
  }
  const port = Number(rest.slice(0, c2));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw badRequest(`Port proxy invalide : ${rest.slice(0, c2)}`);
  }
  const userPass = rest.slice(c2 + 1);
  const c3 = userPass.indexOf(":");
  if (c3 <= 0 || c3 === userPass.length - 1) {
    throw badRequest("Identifiants proxy attendus : user:pass");
  }
  return {
    type: "http",
    host,
    port,
    username: userPass.slice(0, c3),
    password: userPass.slice(c3 + 1),
  };
}

/** Proxy → URL de connexion (pour ProxyAgent undici). */
export function proxyUrl(p: ProxyConfig): string {
  const auth = p.username ? `${encodeURIComponent(p.username)}:${encodeURIComponent(p.password)}@` : "";
  return `http://${auth}${p.host}:${p.port}`;
}

/** Proxy → objet attendu par l'API AnySolver (createTask.proxy). */
export function toAnySolverProxy(p: ProxyConfig): {
  type: string;
  host: string;
  port: number;
  username: string;
  password: string;
} {
  return { type: "http", host: p.host, port: p.port, username: p.username, password: p.password };
}
