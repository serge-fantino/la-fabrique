# Le fichier `.fabrique.json`

À la racine du dépôt d'un projet piloté. Le projet y décrit lui-même ses conventions ; La Fabrique le lit par l'API GitHub (branche de production) et ne suppose rien d'autre. Versionné avec le code : un changement de convention passe par une PR du projet.

Tous les champs sont facultatifs sauf `nom` ; un champ absent masque la fonction qui en dépend (pas de section « Ce qui attend la production » sans `branches.integration`, par exemple).

## Exemple (L'épicerie extraordinaire)

Version complète, telle qu'elle est dans le dépôt de l'épicerie : [`exemples/epicerie.fabrique.json`](exemples/epicerie.fabrique.json) (à recopier quand l'original change ; il sert aussi de jeu de test).

```json
{
  "nom": "L'épicerie extraordinaire",
  "description": "Méta-boutique : de vrais produits de drive, triés par des règles explicites.",
  "branches": {
    "production": "main",
    "integration": "integration",
    "travail": ["feature/*", "refacto/*"]
  },
  "environnements": {
    "int": { "url": "https://…workers.dev", "version": "/api/version", "type": "integration", "signalement": "comptes" },
    "production": { "url": "https://epicerieextraordinaire.com", "version": "/api/version", "type": "production", "signalement": false }
  },
  "recette": { "environnement": "int" },
  "workflows": {
    "ci": "ci.yml",
    "deploiement_int": "deploy-int.yml",
    "migrations_production": "migrations-prod.yml",
    "promouvoir": null,
    "claude": null
  },
  "version": { "fichier": "site/static/nouveautes.json", "forme": "v1.N" },
  "documentation": [
    { "titre": "Le projet", "chemin": "CLAUDE.md" },
    { "titre": "Installer et exploiter", "chemin": "README.md" },
    { "titre": "Refonte technique", "chemin": "docs/refactoring/" }
  ],
  "demandes": {
    "etiquettes": { "demande": "demande", "prete": "prete-pour-claude", "a_valider": "a-valider-sur-int" },
    "rubriques": [
      { "cle": "contexte", "titre": "Contexte", "obligatoire": true, "aide": "…" }
    ]
  }
}
```

## Champs

| Champ | Sert à |
|---|---|
| `nom`, `description` | En-tête du projet dans La Fabrique. |
| `langue` | `fr` ou `en` : la langue de ce que La Fabrique écrit dans le projet (signature d'une demande, commentaire de validation, défaut signalé). Sans elle : `fr`. |
| `branches.production` | La branche en production (comparée à `integration`, versions). |
| `branches.integration` | La branche déployée sur l'environnement de validation : « ce qui attend la production » = ses commits absents de `production`. |
| `branches.travail` | Motifs des branches de travail (une demande en cours y est reliée par son numéro d'issue). |
| `environnements.<nom>.url`, `.version` | Adresse de l'environnement et chemin qui répond la version déployée (JSON avec `numero` ou `version`). Lu en direct, sans compte. |
| `environnements.<nom>.type` | `integration` ou `production`. Le chemin de version répond aussi `environnement` (`int`, `production`…) : *Setup* signale un environnement qui ne répond pas ce que son type annonce. |
| `application.kit` | Le dossier où le projet garde sa copie du kit de signalement (`fabrique-report.js`, `.css`, `-early.js`, sans version dans le nom). *Setup* lit sa version sur la branche d'intégration (ou de production) et propose la mise à jour par une PR. |
| `version.coulisses` | Le marqueur d'un commit qui ne change rien de visible (`[coulisses]` dans l'épicerie) : les PR de La Fabrique (cycle de vie, kit) le portent dans leurs commits et leur titre, pour que les contrôles du projet ne leur demandent pas d'entrée dans les notes de version. |
| `application.nom`, `.retour`, `.local` | L'app du projet reliée à La Fabrique pour signaler un défaut : son nom sur la page de consentement, le chemin où elle revient (`/auth/fabrique/retour`) sur chaque environnement avec `signalement`, et son adresse locale en développement (`http://localhost:8787`). *Setup* en déduit ses adresses de retour et signale un écart. |
| `environnements.<nom>.signalement` | Qui peut signaler un défaut depuis cet environnement avec l'app du projet (ci-dessous) : `"equipe"` (les comptes qui ont un rôle dans La Fabrique), `"comptes"` (tout compte GitHub qui voit le dépôt ; `true` se lit ainsi), ou `false`. La production peut l'ouvrir aussi. `"utilisateurs"` (les utilisateurs de l'app, sans compte) est prévu mais refusé tant que ses règles ne sont pas écrites (données personnelles, quotas, triage). Absent : `false`. |
| `recette` | L'environnement de recette, où les stories attendent leur validation (*To test*, le panneau de test du kit) : `{ "environnement": "int" }`, un seul. Absent : celui de `type` `integration`, sinon, pour un projet sans branche d'intégration, la production. Tester n'est pas signaler : on teste sur la recette seulement, avec un rôle de testeur ou au-delà. |
| `workflows.ci` | Workflow dont l'état est montré pour chaque branche. |
| `workflows.deploiement_int`, `migrations_production` | Workflows suivis (état, dernier passage). |
| `workflows.promouvoir` | Workflow `workflow_dispatch` que le « go » du super admin déclenche. `null` : pas de go depuis La Fabrique. |
| `workflows.publier` | Workflow `workflow_dispatch` (entrées `version`, `titre`, `stories` — numéros séparés par des virgules —, `par`) que « Close the sprint » déclenche sur un projet sans branche d'intégration : une seule version (mineure ou majeure), une seule entrée de notes de version (numéro, date et heure de Paris, titre, changements, stories) à la place des entrées `next` qui déclarent une story faite, une PR sur la branche de production fusionnée (le déploiement suit). Réservé au Product Engineer et au super admin. `null` ou absent : la fermeture du sprint est refusée avec un lien vers Setup. |
| `workflows.claude` | Workflow qui fait travailler Claude sur une demande (`workflow_dispatch` avec le numéro d'issue `issue`, et `par`, qui l'a lancé). Il prend aussi `pr` (remettre une PR à jour) et `rework` (`true` : la story a des retours de test, Claude retravaille son code sur une nouvelle branche de la même story ; « Rework with Claude » du sprint, la-fabrique#202). `null` : pas de bouton « Lancer Claude ». |
| `workflows.fusionner` | Workflow `workflow_dispatch` (entrées `pr` et `par`) que le bouton « Merge » d'une PR du sprint déclenche : il numérote et date les notes de version au moment de la fusion, relance les vérifications et fusionne. Vers la branche de production, c'est un go : Product Engineer et super admin ; vers une autre branche, tech lead. `null` ou absent : pas de bouton. |
| `version.fichier`, `.forme` | Le fichier des notes de version, au format Fabrique (ci-dessous), et la forme des numéros (`v1.N`, `0.N`…). Il alimente Production (ce qui va sortir), Roadmap (calendrier) et Releases. |
| `documentation[]` | Pages publiées dans La Fabrique : un fichier Markdown ou un dossier (tous ses `.md`), rendus depuis la branche de production. |
| `demandes.etiquettes` | Étiquettes GitHub du circuit : demande écrite, prête pour Claude, à valider sur int, et `retour` : une story qui a reçu un retour de test et repasse en développement (`rework` par défaut). |
| `claude.plafond` | Combien de Claude lancés depuis La Fabrique peuvent tourner en même temps sur le projet (1 à 10 ; 2 par défaut). |
| `cycle.pret`, `cycle.priorites` | Le cycle de vie d'une story (ci-dessous) : sa *Definition of Ready* et les étiquettes de priorité, de la plus haute à la plus basse. |
| `composants.dossier` | Le dossier des composants du projet (ci-dessous) ; `components` par défaut. Sans `composants` : pas de composants. |
| `demandes.rubriques[]` | Le formulaire d'une demande : `cle`, `titre`, `obligatoire`, `aide` (texte d'aide affiché). L'issue créée reprend les rubriques en titres de section, dans l'ordre. |

## Cycle d'une story

La Fabrique calcule l'étape de chaque story à partir de GitHub, sans rien stocker :

| Étape | Quand |
|---|---|
| *Backlog* | Ouverte, sa *Definition of Ready* n'est pas remplie. |
| *Ready* | Ouverte, *Definition of Ready* remplie, aucun travail commencé. |
| *In development* | Une branche de travail porte son numéro, ou une PR ouverte la cite. |
| *On int* | Son travail est sur la branche d'intégration et pas encore en production. |
| *In production* | Fermée. |

`cycle.pret` liste les vérifications de la *Definition of Ready*, parmi : `criteres` (au moins un critère d'acceptation, sous un titre *Acceptance criteria* ou *Critères d'acceptation*), `epique` (sous-issue d'une épique), `priorite` (porte une étiquette de `cycle.priorites`), `etiquette_prete` (porte l'étiquette `demandes.etiquettes.prete`). Sans `cycle` : `criteres` et `epique`, et pas de priorité.

```json
"cycle": {
  "pret": ["criteres", "epique", "priorite"],
  "priorites": ["P1", "P2", "P3"]
}
```

Les étiquettes de priorité sont des étiquettes GitHub ordinaires : La Fabrique les pose depuis le backlog et note qui a priorisé quoi dans son journal.

L'onglet *Setup* de La Fabrique propose ce bloc sous forme de formulaire : il ouvre une PR qui ne change que `cycle` dans `.fabrique.json`, au nom de la personne, sur la branche d'intégration (ou de production).

## Signaler un défaut depuis l'app du projet

L'app du projet peut envoyer un défaut depuis la page où on le voit, au nom de la personne qui l'utilise, avec la page, le composant choisi, la version et, au choix, une capture. Elle se relie à La Fabrique en OAuth (code d'autorisation et PKCE, client confidentiel enregistré par le super admin dans *Settings → Connected apps*, seule portée `defects:report`) ; elle ne reçoit jamais de jeton GitHub. Le contrat (adresses, champs, réponses) est dans la-fabrique#65.

Signaler et tester sont deux activités. On signale depuis tout environnement qui l'ouvre (`signalement`), production comprise, selon le public qu'il déclare. On teste les stories sur la seule recette (`recette`) : sur int, celles qui y sont ; sans int, en production, celles dont la PR est fusionnée et qui restent ouvertes, et celles revenues en développement après un retour.

La Fabrique n'accepte un défaut que d'un environnement dont `signalement` ouvre le signalement à la personne (`"equipe"` : un rôle ; `"comptes"` : tout compte qui voit le dépôt), et seulement si son chemin de version répond le même `environnement` que celui du défaut. La déclaration est lue sur la branche déployée dans l'environnement : pour int, la branche d'intégration (un environnement que la production déclare de `type` `production` reste fermé). L'issue est créée par l'App de La Fabrique, avec l'étiquette `bug` (et `to triage` pour un compte sans rôle), reliée à la story en cours sur int quand il n'y en a qu'une, signée de la personne ; la capture est gardée par La Fabrique, à une adresse impossible à deviner. 20 défauts par jour au plus, par compte et par projet.

Le super admin enregistre l'app depuis l'onglet *Setup* du projet (*Connected app*) : nom et adresses de retour sont pré-remplis d'après `application`, l'identifiant et le secret s'affichent une fois avec les commandes `wrangler secret put` à lancer dans le projet (`FABRIQUE_CLIENT_ID`, `FABRIQUE_CLIENT_SECRET`, et la variable `FABRIQUE_URL`). Il y renouvelle le secret sans couper les connexions, aligne les adresses sur `.fabrique.json`, ou retire l'app.

```json
"application": { "nom": "L'épicerie extraordinaire", "retour": "/auth/fabrique/retour", "local": "http://localhost:8787" }
```

Il suffit que le compte GitHub de la personne voie le dépôt : un rôle dans La Fabrique n'est pas nécessaire pour signaler.

## Composants

Un composant est une fonction que le projet a déjà et qui pourrait servir ailleurs (signaler un défaut, notes de version, centre de confidentialité…), décrite une fois. C'est un dossier du dépôt du projet, qui se décrit lui-même, avec ou sans code, dans le dossier que déclare `composants` (épique F6, la-fabrique#194) :

```json
"composants": { "dossier": "components" }
```

Chaque sous-dossier est un composant ; son nom est son identifiant (minuscules, chiffres, tirets). Ce qu'il contient :

```
components/
  report-and-test-kit/
    component.json        ← obligatoire : ce qu'il est, ce qu'il apporte, ce qu'il demande, son code
    README.md             ← la présentation
    spec.md               ← la spec et ses critères d'acceptation : elle fait foi
    scenarios/*.feature   ← les scénarios (Gherkin) : ils valident une implémentation, et une réécriture
    privacy.md            ← les données personnelles : quoi, pourquoi, combien de temps
    CHANGELOG.md          ← les versions, avec ce que chacune demande au projet
```

`component.json` :

```json
{
  "nom": "Report a defect and test from the app",
  "nature": "produit",
  "version": "1.6.0",
  "resume": "…",
  "apporte": ["Un bouton « Signaler un défaut »", "…"],
  "demande": [{ "type": "route", "description": "Un relais générique côté serveur" }],
  "dependances": [],
  "implementations": [{ "stack": { "langage": "javascript", "front": "html-sans-build" }, "chemin": "/kit" }],
  "donnees_personnelles": "privacy.md",
  "origine": null
}
```

| Champ | Sert à |
|---|---|
| `nom` | Obligatoire : son nom. |
| `nature` | Obligatoire : `produit` (une fonction qu'on voit), `bibliotheque` (du code sans interface) ou `design-system` (jetons, composants d'interface). |
| `version`, `resume` | Sa version (`1.6.0`) et une phrase qui le dit. |
| `apporte`, `demande` | Ce qu'il apporte (des textes), et ce que le projet doit fournir pour l'avoir (`type` : route, table, variable, secret, oauth, csp… et `description`). |
| `dependances` | Les identifiants des autres composants du projet dont il a besoin. |
| `implementations[]` | Son code pour une stack : `stack` (des paires libres, `{ "langage": "typescript", "hebergement": "cloudflare-workers" }`) et `chemin`, un dossier du composant, ou du dépôt quand il commence par `/`. Aucune : une spec seule, de quoi l'écrire pour n'importe quelle stack. |
| `donnees_personnelles` | Le fichier qui dit les données personnelles qu'il touche (`privacy.md`). |
| `origine` | Repris d'un autre projet (le partage passe par git) : `depot` (adresse https), `chemin`, `version`, `commit`. |

La Fabrique lit les composants à chaque commit (comme la documentation) et les montre dans l'onglet *Components* du projet ; un `component.json` invalide y est listé avec ses raisons. Elle ne garde rien d'autre que ce cache.

## Validation

La Fabrique vérifie le fichier à l'ajout du projet et à chaque push sur la branche de production : JSON valide, `nom` présent, workflows nommés existants dans `.github/workflows/`, chemins de documentation existants. Une erreur est montrée sur la page du projet, sans bloquer le reste.

## Notes de version (format Fabrique)

Le fichier nommé par `version.fichier` est un tableau JSON, **la version la plus récente en premier**. Une entrée par version mise en ligne :

```json
[
  {
    "version": "1.168",
    "date": "2026-10-30",
    "heure": "09:15",
    "titre": "E-mails de bienvenue",
    "changements": ["Un e-mail de bienvenue à l'inscription."],
    "stories": [138],
    "liens": [{ "app": "/app/accueil.html" }]
  }
]
```

| Champ | Sens |
|---|---|
| `version` | Le numéro, dans la forme de `version.forme`. Unique. `"next"` (en tête seulement, sans `heure`) : une entrée pas encore numérotée, écrite par une PR qui ne touche jamais au numéro ; le workflow de fusion (`workflows.fusionner`) lui donne le sien, après le plus récent, avec l'heure de la fusion. |
| `date`, `heure` | Jour (`AAAA-MM-JJ`) et heure (`HH:MM`, heure du projet) de mise en ligne. **Une entrée sans `heure` n'est pas encore en ligne** : elle s'écrit dès la branche de travail et reçoit son heure au moment de la mise en production. |
| `titre` | Une ligne, facultative. |
| `changements` | Les changements visibles, dits pour un utilisateur curieux, sans jargon. Toujours du texte. |
| `liens` | Facultatif : `null`, ou des objets dont chaque valeur est un chemin du site en production (`/app/…`), pour « y aller ». |
| `stories` | Les numéros des issues (stories) que la version apporte, `[]` si aucune. C'est le seul lien entre une note de version et ses stories : « Ça concerne » d'un signalement de défaut et le triage proposent chaque version avec les stories qu'elle déclare, *Releases* les montre. Une entrée qui ne le dit pas n'en a aucune (La Fabrique ne devine rien d'après les branches ou les dates). À exiger dans le contrôle de version du projet pour toute nouvelle entrée. |

Un envoi sans rien de visible (outillage, tests, refonte interne) n'ajoute pas d'entrée. Le chemin de version des environnements (`environnements.*.version`) répond la version déployée (`numero`), qui doit être celle de la première entrée.

Sans branche d'intégration, une entrée reçoit sa date et son heure quand elle part sur la branche de production.
