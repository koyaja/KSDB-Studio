# Journal des versions

Chaque section `## [X.Y.Z]` devient automatiquement les notes de la release GitHub correspondante,
affichées aussi dans la fenêtre de mise à jour de KSDB Studio.

## [1.7.0]

### Nouveautés
- **Version macOS** : `.dmg` pour Apple Silicon (M1 à M4) et pour Intel
  - menu d’application macOS (⌘Q, masquer, fenêtres)
  - mises à jour : le bon `.dmg` est téléchargé selon le processeur
  - VPN : tunnels de l’application WireGuard (App Store) sans mot de passe, fichiers `.conf` via `wg-quick` (Homebrew)
  - outils de sauvegarde détectés dans Homebrew (`libpq`, `postgresql@…`, `mysql-client`, `mariadb`) et Postgres.app

### Installation macOS
L’application n’est pas notariée : au premier lancement, **Réglages Système → Confidentialité et sécurité → Ouvrir quand même**. Si macOS la dit « endommagée » : `xattr -cr "/Applications/KSDB Studio.app"`.

## [1.6.0]

### Nouveautés
- **Transfert de données entre serveurs** : clic droit sur un schéma, une base ou une table → « Transférer les données… »
  - même serveur ou serveurs différents, tunnels SSH et VPN compris
  - **PostgreSQL ↔ MySQL / MariaDB** : colonnes associées par nom, valeurs converties (booléens, JSON, dates avec fuseau, binaires)
  - création des tables manquantes ou recréation complète (même moteur), clés étrangères ajoutées après les données
  - filtre `WHERE` par table, vidage préalable, doublons ignorés, séquences et auto-incréments recalés
  - lecture en flux et insertion par lots, une transaction par table, progression en direct, arrêt possible

### Corrections
- Comparaison de schémas : les colonnes calculées PostgreSQL (`GENERATED ALWAYS AS … STORED`) sont recréées correctement

## [1.5.2]

### Corrections
- Compilation Windows réparée : l’installateur `.exe` est de nouveau joint aux releases
- La version de l’application suit toujours le tag de la release

### Rappel des nouveautés récentes
- **Comparaison et synchronisation de schémas** (source → cible) avec script de migration
- **Diagramme ERD** avec export PNG / SVG
- Version affichée et **notifications de mise à jour**
- Thèmes **Papier** et **Nuit douce**, bascule selon l’heure
- **VPN WireGuard** par connexion ou par groupe

## [1.5.0]

### Nouveautés
- Comparaison et synchronisation de schémas PostgreSQL et MySQL/MariaDB : tables, colonnes, clés, index, clés étrangères, vues, fonctions, procédures, triggers
- Script ordonné, vues dépendantes recréées automatiquement, suppressions décochées par défaut
- Application sur la cible dans une transaction (PostgreSQL)

## [1.4.0]

### Nouveautés
- Version affichée dans la barre d’état, l’accueil et « À propos »
- Vérification des nouvelles releases, notification système, téléchargement et installation

## [1.3.0]

### Nouveautés
- Diagramme ERD : mise en page automatique, zoom, recherche, relations en évidence, requête avec jointures, export PNG / SVG

## [1.2.0]

### Nouveautés
- Thèmes Papier et Nuit douce, bascule selon l’heure ou le système

## [1.1.0]

### Nouveautés
- VPN WireGuard associé à une connexion ou à un groupe, démarrage automatique

## [1.0.0]

- Première version : PostgreSQL, MySQL, MariaDB, tunnel SSH, import Navicat, éditeur SQL, édition des données, concepteur de table, import / export, sauvegarde / restauration
