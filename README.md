# sigma-exchange2
# sigma-exchange

Simulateur boursier et jeu de cartes à collectionner (monnaie 100 % virtuelle).

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
| `NODE_ENV` | `production` sur Render (active SSL et les cookies sécurisés) |
| `PORT` | Port d'écoute (3000 par défaut) |
