# sigma-exchange2

Simulateur boursier et jeu de cartes à collectionner (monnaie 100 % virtuelle).

## Fonctionnalités

- 26 entreprises fictives avec graphiques d'évolution (1 h, 6 h, 24 h, 3 jours) et cours simulés
- Portefeuille avec répartition, gains/pertes et vente rapide
- 42 cartes (5 raretés) et 5 packs aux probabilités différentes, visuels générés en SVG
- Chat en direct, titres à débloquer
- Boutique : packs achetables jusqu'à 10 à la fois, probabilités affichées, stock avec compte à rebours de réapprovisionnement
- Bazar : cartes regroupées avec prix le plus bas, fiche de marché (offres, graphique des ventes), vente au prix de son choix (commission de 5 %)
- Amis : demandes, présence en ligne, profil (collection et titres), cadeaux de cartes
- Adresse e-mail valide obligatoire pour chaque compte
- Administration : statistiques, gestion des joueurs (solde, rôle, suspension, silence, cadeaux),
  boutique, bazar, diagnostic de la base de données, entreprises, événements de marché (krach/boom), cartes, annonce du site, journal

## Lancer le projet

```bash
npm install
cp .env.example .env   # puis remplis les valeurs
npm start
```

## Variables d'environnement

| Variable | Rôle |
| --- | --- |
| `DATABASE_URL` | Connexion PostgreSQL (obligatoire) |
| `SESSION_SECRET` | Secret de session, 32 caractères minimum (obligatoire) |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | Crée ou promeut le compte admin (mot de passe 12 caractères minimum) |
| `ADMIN_EMAIL` | E-mail du compte admin (par défaut `sammi.mahdeb@outlook.fr`) |
| `NODE_ENV` | `production` sur Render (active SSL et les cookies sécurisés) |
| `PORT` | Port d'écoute (3000 par défaut) |
