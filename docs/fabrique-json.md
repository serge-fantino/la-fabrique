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
    "int": { "url": "https://…workers.dev", "version": "/api/version" },
    "production": { "url": "https://epicerieextraordinaire.com", "version": "/api/version" }
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
| `branches.production` | La branche en production (comparée à `integration`, versions). |
| `branches.integration` | La branche déployée sur l'environnement de validation : « ce qui attend la production » = ses commits absents de `production`. |
| `branches.travail` | Motifs des branches de travail (une demande en cours y est reliée par son numéro d'issue). |
| `environnements.<nom>.url`, `.version` | Adresse de l'environnement et chemin qui répond la version déployée (JSON avec `numero` ou `version`). Lu en direct, sans compte. |
| `workflows.ci` | Workflow dont l'état est montré pour chaque branche. |
| `workflows.deploiement_int`, `migrations_production` | Workflows suivis (état, dernier passage). |
| `workflows.promouvoir` | Workflow `workflow_dispatch` que le « go » du super admin déclenche. `null` : pas de go depuis La Fabrique. |
| `workflows.claude` | Workflow qui fait travailler Claude sur une demande (`workflow_dispatch` avec le numéro d'issue). `null` : pas de bouton « Lancer Claude ». |
| `version.fichier`, `.forme` | Où lire le numéro de version lisible (« Quoi de neuf »). |
| `documentation[]` | Pages publiées dans La Fabrique : un fichier Markdown ou un dossier (tous ses `.md`), rendus depuis la branche de production. |
| `demandes.etiquettes` | Étiquettes GitHub du circuit : demande écrite, prête pour Claude, à valider sur int. |
| `demandes.rubriques[]` | Le formulaire d'une demande : `cle`, `titre`, `obligatoire`, `aide` (texte d'aide affiché). L'issue créée reprend les rubriques en titres de section, dans l'ordre. |

## Validation

La Fabrique vérifie le fichier à l'ajout du projet et à chaque push sur la branche de production : JSON valide, `nom` présent, workflows nommés existants dans `.github/workflows/`, chemins de documentation existants. Une erreur est montrée sur la page du projet, sans bloquer le reste.
