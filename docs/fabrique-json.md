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
    "int": { "url": "https://…workers.dev", "version": "/api/version", "type": "integration", "signalement": true },
    "production": { "url": "https://epicerieextraordinaire.com", "version": "/api/version", "type": "production", "signalement": false }
  },
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
| `environnements.<nom>.signalement` | `true` : l'app du projet peut signaler un défaut depuis cet environnement (ci-dessous). Jamais sur la production (`false`, et refusé avec `type: "production"`). Absent : `false`. |
| `workflows.ci` | Workflow dont l'état est montré pour chaque branche. |
| `workflows.deploiement_int`, `migrations_production` | Workflows suivis (état, dernier passage). |
| `workflows.promouvoir` | Workflow `workflow_dispatch` que le « go » du super admin déclenche. `null` : pas de go depuis La Fabrique. |
| `workflows.publier` | Workflow `workflow_dispatch` (entrées `version`, `titre`, `stories` — numéros séparés par des virgules —, `par`) que « Close the sprint » déclenche sur un projet sans branche d'intégration : une seule version (mineure ou majeure), une seule entrée de notes de version (numéro, date et heure de Paris, titre, changements, stories) à la place des entrées `next` qui déclarent une story faite, une PR sur la branche de production fusionnée (le déploiement suit). Réservé au Product Engineer et au super admin. `null` ou absent : la fermeture du sprint est refusée avec un lien vers Setup. |
| `workflows.claude` | Workflow qui fait travailler Claude sur une demande (`workflow_dispatch` avec le numéro d'issue). `null` : pas de bouton « Lancer Claude ». |
| `workflows.fusionner` | Workflow `workflow_dispatch` (entrées `pr` et `par`) que le bouton « Merge » d'une PR du sprint déclenche : il numérote et date les notes de version au moment de la fusion, relance les vérifications et fusionne. Vers la branche de production, c'est un go : Product Engineer et super admin ; vers une autre branche, tech lead. `null` ou absent : pas de bouton. |
| `version.fichier`, `.forme` | Le fichier des notes de version, au format Fabrique (ci-dessous), et la forme des numéros (`v1.N`, `0.N`…). Il alimente Production (ce qui va sortir), Roadmap (calendrier) et Releases. |
| `documentation[]` | Pages publiées dans La Fabrique : un fichier Markdown ou un dossier (tous ses `.md`), rendus depuis la branche de production. |
| `demandes.etiquettes` | Étiquettes GitHub du circuit : demande écrite, prête pour Claude, à valider sur int. |
| `claude.plafond` | Combien de Claude lancés depuis La Fabrique peuvent tourner en même temps sur le projet (1 à 10 ; 2 par défaut). |
| `cycle.pret`, `cycle.priorites` | Le cycle de vie d'une story (ci-dessous) : sa *Definition of Ready* et les étiquettes de priorité, de la plus haute à la plus basse. |
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

La Fabrique n'accepte un défaut que d'un environnement déclaré avec `"signalement": true`, et seulement si son chemin de version répond le même `environnement` que celui du défaut. La déclaration est lue sur la branche déployée dans l'environnement : pour int, la branche d'intégration (un environnement que la production déclare de `type` `production` reste fermé). L'issue est créée par l'App de La Fabrique, avec l'étiquette `bug` (et `to triage` pour un compte sans rôle), reliée à la story en cours sur int quand il n'y en a qu'une, signée de la personne ; la capture est gardée par La Fabrique, à une adresse impossible à deviner. 20 défauts par jour au plus, par compte et par projet.

Le super admin enregistre l'app depuis l'onglet *Setup* du projet (*Connected app*) : nom et adresses de retour sont pré-remplis d'après `application`, l'identifiant et le secret s'affichent une fois avec les commandes `wrangler secret put` à lancer dans le projet (`FABRIQUE_CLIENT_ID`, `FABRIQUE_CLIENT_SECRET`, et la variable `FABRIQUE_URL`). Il y renouvelle le secret sans couper les connexions, aligne les adresses sur `.fabrique.json`, ou retire l'app.

```json
"application": { "nom": "L'épicerie extraordinaire", "retour": "/auth/fabrique/retour", "local": "http://localhost:8787" }
```

Il suffit que le compte GitHub de la personne voie le dépôt : un rôle dans La Fabrique n'est pas nécessaire pour signaler.

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
