import { expect, test } from "@playwright/test";

/**
 * Tests navigateur de la console (phase 13) — joués contre le serveur live
 * local (127.0.0.1:8787, frontend construit servi par le backend).
 * Prérequis : `npm run build` + serveur lancé.
 */

test("la console charge : rail, statut, barre d'état", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Recherche" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Navigation principale" })).toBeVisible();
  // barre d'état : mode (fixtures ou live) + version
  await expect(page.locator(".statusbar")).toContainText(/fixtures|live/);
  await expect(page.locator(".statusbar")).toContainText("v");
});

test("navigation clavier 1-5 sur les cinq vues", async ({ page }) => {
  await page.goto("/");
  // attend que l'app soit montée (listeners clavier attachés) avant de taper
  await expect(page.getByRole("navigation", { name: "Navigation principale" })).toBeVisible();
  await page.waitForTimeout(300);
  for (const [key, titre] of [
    ["2", "Veilles"],
    ["3", "Messagerie"],
    ["4", "Webhooks"],
    ["5", "Système"],
    ["1", "Recherche"],
  ] as const) {
    await page.keyboard.press(key);
    await expect(page.getByRole("heading", { name: titre })).toBeVisible();
  }
});

test("le tableau de recherche affiche des annonces réelles", async ({ page }) => {
  await page.goto("/");
  await page.getByPlaceholder("Rechercher…  (/)").fill("vélo");
  await page.keyboard.press("Enter");
  // le job live part, la table se remplit (SSE → invalidate)
  await expect(page.locator('[role="row"]').first()).toBeVisible({ timeout: 15_000 });
  const rows = await page.locator('[role="row"]').count();
  expect(rows).toBeGreaterThan(2);
});

test("le focus clavier / fonctionne", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Veilles" }).click();
  await expect(page.getByRole("heading", { name: "Veilles" })).toBeVisible();
  await page.getByRole("button", { name: "Recherche" }).click();
  await page.keyboard.press("/");
  await expect(page.getByPlaceholder("Rechercher…  (/)")).toBeFocused();
});

test("écran d'aide ?", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("navigation", { name: "Navigation principale" })).toBeVisible();
  await page.waitForTimeout(300);
  await page.keyboard.press("?");
  await expect(page.getByRole("dialog", { name: "Raccourcis clavier" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Raccourcis clavier" })).toBeHidden();
});

test("l'écran Système expose les sections clés", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Système" }).click();
  await expect(page.getByText("Connexion Chrome — capture DevTools")).toBeVisible();
  await expect(page.getByText("Routage réseau")).toBeVisible();
  await expect(page.getByText("Stress test")).toBeVisible();
});

test("veilles : le bouton modifier ouvre le formulaire d'édition", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Veilles" }).click();
  const editBtn = page.getByRole("button", { name: "modifier" }).first();
  if ((await editBtn.count()) > 0) {
    await editBtn.click();
    await expect(page.getByRole("button", { name: "Enregistrer" })).toBeVisible();
    await page.getByRole("button", { name: "Annuler" }).click();
  }
});
