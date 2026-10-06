import type { Lane } from "../config/schema";
import type { Complexity, ImplementerModel, RouteSignals } from "./types";

/**
 * Keyword triage — the offline fallback when Jev is not configured, is
 * unreachable, or is unsure. Deliberately simple and conservative: when nothing
 * matches, the task gets the `standard` lane. English and Spanish keywords.
 */

const CHORE: RegExp[] = [
  /\bupgrad/,
  /\bbump/,
  /\bupdate (?:the |all |our )?(?:deps|dependenc|packages?|sdk|librar|versions?)/,
  /\bmigrat\w* (?:to|from) (?:v?\d|expo|react|next|sdk|node|typescript|eslint|vite|tailwind)/,
  /\bcodemod/,
  /\bexpo sdk/,
  /\bsdk ?\d+/,
  /\b(?:renovate|dependabot)\b/,
  /\bdeprecat/,
  /\bactualiz\w* (?:a |el |la |los |las |de )?(?:expo|sdk|dependencias|paquetes|librer|versi|react|node|next)/,
  /\bmigra\w* (?:a|de) (?:v?\d|expo|sdk|react|next|node|typescript)/,
  /\bsubir (?:de |la )?versi/,
];

const FULL: RegExp[] = [
  /\bauth/,
  /\blog ?in\b/,
  /\bsign ?(?:up|in)\b/,
  /\boauth/,
  /\bsso\b/,
  /\bpassword/,
  /\bpayments?\b/,
  /\bbilling/,
  /\bcheckout/,
  /\bsubscription/,
  /\bpermission/,
  /\brbac\b/,
  /\bencrypt/,
  /\bsecurity/,
  /\barchitect/,
  /\brewrite/,
  /\bnew (?:module|service|subsystem|app)/,
  /\bmulti-?tenan/,
  /\bschema/,
  /\bdatabase migration/,
  /\boffline/,
  /\bsync engine/,
  /\bautentic/,
  /\bcontrase/,
  /\bpagos?\b/,
  /\bfacturaci/,
  /\bsuscripci/,
  /\bpermisos?\b/,
  /\bseguridad/,
  /\barquitectur/,
  /\breescrib/,
  /\bnuevo m.dulo/,
  /\besquema/,
  /\bbase de datos/,
];

const QUICK: RegExp[] = [
  /\btypos?\b/,
  /\bwording/,
  /\bcopy\b/,
  /\blabel/,
  /\btitle\b/,
  /\bcolou?rs?\b/,
  /\bpadding/,
  /\bmargin/,
  /\bspacing/,
  /\bfont size/,
  /\bicon\b/,
  /\bcomments?\b/,
  /\breadme/,
  /\btweak/,
  /\bminor\b/,
  /\bsmall\b/,
  /\bone[- ]line/,
  /\brename\b/,
  /\bremove (?:unused|dead) /,
  /\blog(?:ging)? (?:line|statement)/,
  /\berrata/,
  /\btexto\b/,
  /\betiqueta/,
  /\bt.tulo/,
  /\bespaciado/,
  /\bcomentario/,
  /\bpeque/,
  /\bmenor\b/,
  /\bajuste/,
  /\brenombr/,
  /\b.cono\b/,
];

const SECURITY: RegExp[] = [
  /\bauth/,
  /\blog ?in\b/,
  /\bpassword/,
  /\btokens?\b/,
  /\bsecrets?\b/,
  /\bpayments?\b/,
  /\bpermission/,
  /\bencrypt/,
  /\bcredential/,
  /\bcookie/,
  /\bapi keys?\b/,
  /\bsanitiz/,
  /\bsql\b/,
  /\bxss\b/,
  /\bcsrf\b/,
  /\bupload/,
  /\bwebhook/,
  /\bcontrase/,
  /\bautentic/,
  /\bcredencial/,
  /\bpagos?\b/,
  /\bpermisos?\b/,
  /\bseguridad/,
];

const UI: RegExp[] = [
  /\bui\b/,
  /\bux\b/,
  /\bscreens?\b/,
  /\bpages?\b/,
  /\bcomponents?\b/,
  /\bbuttons?\b/,
  /\bmodal/,
  /\blayout/,
  /\bstyl/,
  /\bcss\b/,
  /\btailwind/,
  /\banimat/,
  /\bdesign/,
  /\btheme/,
  /\bdark mode/,
  /\bcopy\b/,
  /\bforms?\b/,
  /\bicons?\b/,
  /\bcolou?rs?\b/,
  /\bfonts?\b/,
  /\bpantalla/,
  /\bbot.n/,
  /\bcomponente/,
  /\bdise.o/,
  /\bestilo/,
  /\banimaci/,
  /\bvista/,
  /\bformulario/,
  /\btema\b/,
];

/** Majors and frameworks make an upgrade a real piece of work, not a bump. */
const BIG_CHORE = /\bmajor|\bsdk|expo|react native|\bnext\b|framework|\d+ ?(?:→|->|to|a) ?\d+/;

const hits = (text: string, patterns: RegExp[]): number =>
  patterns.reduce((n, re) => (re.test(text) ? n + 1 : n), 0);

function modelFor(lane: Lane, complexity: Complexity): ImplementerModel {
  if (complexity === "trivial") return "haiku";
  if (complexity === "large") return "opus";
  return lane === "full" ? "opus" : "sonnet";
}

export function heuristicSignals(task: string): RouteSignals {
  const text = task.toLowerCase();
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const security = hits(text, SECURITY) > 0;
  const ui = hits(text, UI) > 0;
  const fullHits = hits(text, FULL);

  // A short request with a "quick" word ("fix the typo on the login button")
  // is quick even if it names a risky area; the security rule in
  // deriveDecision then raises it to standard so it still gets a review.
  const quickHits = hits(text, QUICK);
  let lane: Lane;
  if (hits(text, CHORE) > 0) lane = "chore";
  else if (quickHits > 0 && words <= 15) lane = "quick";
  else if (fullHits > 0) lane = "full";
  else if (quickHits > 0 && words <= 25) lane = "quick";
  else lane = "standard";

  let complexity: Complexity;
  switch (lane) {
    case "quick":
      complexity = words <= 12 ? "trivial" : "small";
      break;
    case "chore":
      complexity = BIG_CHORE.test(text) ? "medium" : "small";
      break;
    case "standard":
      complexity = words > 40 ? "medium" : "small";
      break;
    default:
      complexity = words > 40 || fullHits >= 2 ? "large" : "medium";
  }

  return { lane, complexity, implementerModel: modelFor(lane, complexity), security, ui };
}
