import type { Project } from "./projects";

// What La Fabrique writes in a project follows the project's language
// (`langue` in .fabrique.json; French when absent, as the first requests).
const WORDS = {
  fr: {
    requestSignature: (login: string) => `Demande de @${login} via La Fabrique extraordinaire`,
    validated: (login: string, version: string | null) =>
      `Validé sur int par @${login}${version ? ` (version ${version})` : ""} : tous les critères d'acceptation sont vérifiés.`,
    validatedInProduction: (login: string) => `Validé par @${login} : tous les critères d'acceptation sont vérifiés. La demande reste ouverte jusqu'à la version qui la livre.`,
    shipped: (version: string | null) => `En production${version ? ` en version ${version}` : ""}, après sa validation sur int : la demande est terminée (La Fabrique extraordinaire).`,
    inVersion: (version: string) => `En production en version ${version}.`,
    defectIntro: (story: number) => `Défaut trouvé sur int en testant #${story}.`,
    did: "Ce que j'ai fait",
    saw: "Ce que j'ai vu",
    expected: "Ce que j'attendais",
    defectSignature: (login: string, version: string | null) =>
      `Signalé depuis La Fabrique extraordinaire par @${login}${version ? `, sur int en version ${version}` : ""}`,
    defectOnStory: (login: string, number: number) => `Défaut signalé par @${login} : #${number}`,
    claudeLaunched: (login: string, url: string | null) =>
      `Claude lancé sur cette demande par @${login} depuis La Fabrique extraordinaire${url ? ` : ${url}` : "."}`,
    claudeUpdating: (login: string, url: string | null) =>
      `Claude remet cette PR à jour (fusion de la branche de base, conflits, vérifications), lancé par @${login} depuis La Fabrique extraordinaire${url ? ` : ${url}` : "."}`,
    appDefectIntro: (environment: string, story: number | null) =>
      `Défaut signalé depuis l'app, sur ${environment}${story ? `, en testant #${story}` : ""}.`,
    onIntThen: (stories: number[]) => `Sur ${stories.length > 1 ? "int à ce moment-là" : "int"} : ${stories.map((n) => `#${n}`).join(", ")}.`,
    aboutRelease: (version: string, title: string | null) => `Concerne la version ${version}${title ? ` « ${title} »` : ""}.`,
    defectLinked: (login: string, defect: number) => `Défaut #${defect} relié à cette story par @${login}`,
    linkedTo: (login: string, story: number | null, release: string | null) =>
      story !== null
        ? `Relié à #${story}${release ? ` (version ${release})` : ""} par @${login}, via La Fabrique extraordinaire`
        : release
          ? `Concerne la version ${release}, sans story particulière (@${login}, via La Fabrique extraordinaire)`
          : `Relié à aucune story (@${login}, via La Fabrique extraordinaire)`,
    context: "Contexte",
    contextRows: { environment: "Environnement", version: "Version", page: "Page", component: "Composant", viewport: "Écran", userAgent: "Navigateur" },
    deployment: "déploiement",
    errors: "Erreurs",
    screenshot: "Capture",
    appDefectSignature: (login: string, app: string | null) =>
      `Signalé par @${login}${app ? ` depuis ${app}` : ""}, via La Fabrique extraordinaire`,
    toTriage: (login: string) => `@${login} n'a pas de rôle dans La Fabrique : à trier.`,
    fromCard: (ref: string, url: string, version: number, part?: { index: number; total: number }) =>
      `Fiche d'origine : [${ref}, spec en version ${version}](${url}) dans La Fabrique extraordinaire${part ? ` (story ${part.index} sur ${part.total})` : ""}.`,
    storyReview: (ref: string, url: string, version: number, login: string) =>
      `Après un changement de la fiche [${ref}, spec en version ${version}](${url}) : revue de @${login} avec Claude, via La Fabrique extraordinaire.`,
  },
  en: {
    requestSignature: (login: string) => `Request from @${login} via La Fabrique extraordinaire`,
    validated: (login: string, version: string | null) =>
      `Validated on int by @${login}${version ? ` (version ${version})` : ""}: every acceptance criterion checked.`,
    validatedInProduction: (login: string) => `Validated by @${login}: every acceptance criterion checked. The story stays open until the release that ships it.`,
    shipped: (version: string | null) => `In production${version ? ` in version ${version}` : ""}, after its validation on int: the story is done (La Fabrique extraordinaire).`,
    inVersion: (version: string) => `In production in version ${version}`,
    defectIntro: (story: number) => `Defect found on int while testing #${story}.`,
    did: "What I did",
    saw: "What I saw",
    expected: "What I expected",
    defectSignature: (login: string, version: string | null) =>
      `Reported from La Fabrique extraordinaire by @${login}${version ? `, on int at version ${version}` : ""}`,
    defectOnStory: (login: string, number: number) => `Defect reported by @${login}: #${number}`,
    claudeLaunched: (login: string, url: string | null) =>
      `Claude launched on this story by @${login} from La Fabrique extraordinaire${url ? `: ${url}` : "."}`,
    claudeUpdating: (login: string, url: string | null) =>
      `Claude brings this pull request up to date (merges its base branch, resolves the conflicts, checks again), launched by @${login} from La Fabrique extraordinaire${url ? `: ${url}` : "."}`,
    appDefectIntro: (environment: string, story: number | null) =>
      `Defect reported from the app, on ${environment}${story ? `, while testing #${story}` : ""}.`,
    onIntThen: (stories: number[]) => `On int at the time: ${stories.map((n) => `#${n}`).join(", ")}.`,
    aboutRelease: (version: string, title: string | null) => `About version ${version}${title ? ` “${title}”` : ""}.`,
    defectLinked: (login: string, defect: number) => `Defect #${defect} linked to this story by @${login}`,
    linkedTo: (login: string, story: number | null, release: string | null) =>
      story !== null
        ? `Linked to #${story}${release ? ` (version ${release})` : ""} by @${login}, via La Fabrique extraordinaire`
        : release
          ? `About version ${release}, no particular story (@${login}, via La Fabrique extraordinaire)`
          : `Linked to no story (@${login}, via La Fabrique extraordinaire)`,
    context: "Context",
    contextRows: { environment: "Environment", version: "Version", page: "Page", component: "Component", viewport: "Screen", userAgent: "Browser" },
    deployment: "deployment",
    errors: "Errors",
    screenshot: "Screenshot",
    appDefectSignature: (login: string, app: string | null) =>
      `Reported by @${login}${app ? ` from ${app}` : ""}, via La Fabrique extraordinaire`,
    toTriage: (login: string) => `@${login} has no role in La Fabrique: to triage.`,
    fromCard: (ref: string, url: string, version: number, part?: { index: number; total: number }) =>
      `From card [${ref}, spec version ${version}](${url}) in La Fabrique extraordinaire${part ? ` (story ${part.index} of ${part.total})` : ""}.`,
    storyReview: (ref: string, url: string, version: number, login: string) =>
      `After a change of card [${ref}, spec version ${version}](${url}): reviewed by @${login} with Claude, via La Fabrique extraordinaire.`,
  },
};

export type Wording = (typeof WORDS)["fr"];

export function wordingFor(project?: Project): Wording {
  return WORDS[project?.check?.config?.langue ?? "fr"];
}
