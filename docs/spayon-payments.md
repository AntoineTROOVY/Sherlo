# Paiement unique Spayon

Sherlo utilise désormais Spayon pour un paiement unique de **59 EUR**, sans produit à créer dans le panneau Spayon. Chaque paiement confirmé ouvre **40 années calendaires d’accès**, à compter de sa validation. Il n’y a aucun prélèvement automatique. Après expiration, un nouveau paiement est nécessaire.

Les comptes restent dans la base d’authentification actuelle de Sherlo (`AUTH_DATABASE_PATH`, par défaut `data/auth.sqlite`). Les commandes et leurs droits sont enregistrés dans la table `sherlo_spayon_order`, créée automatiquement au démarrage. Sauvegarder et conserver cette base sur un volume persistant. Les essais gratuits existants et l’exemption des administrateurs sont conservés.

## Configuration sandbox

Renseigner côté serveur, dans `.env` en local ou dans les variables du service hébergé :

```dotenv
SPAYON_ENVIRONMENT=sandbox
SPAYON_CLIENT_ID=<Client ID sandbox du panneau Spayon>
SPAYON_CLIENT_SECRET=<Client Secret sandbox du panneau Spayon>
SPAYON_PRICE=59
SPAYON_CURRENCY=EUR
BETTER_AUTH_URL=https://adresse-publique-api.example
DASHBOARD_URL=https://adresse-publique-dashboard.example
```

`SPAYON_PRICE` est exprimé en unités monétaires : `59` signifie 59 euros, pas 59 centimes. Les identifiants ne doivent jamais être préfixés par `VITE_` ni envoyés au navigateur. Sans identifiants, l’offre s’affiche mais le paiement est indisponible ; les accès payants restent contrôlés après l’essai gratuit.

Spayon documente `EUR`, `AMD`, `USD`, `RUB` et `GBP`. Le test réel de création accepte 59 EUR : le formulaire affiche ce montant, puis indique une conversion en AMD pour le traitement du règlement. Aucun taux de change n’est inventé : si le compte exige l’AMD, définir le prix AMD convenu et la devise ensemble avant de facturer.

Pour un test local avec des identifiants de production, les URL de paiement peuvent être définies séparément de l’authentification :

```dotenv
SPAYON_CALLBACK_URL=https://adresse-publique/api/account/spayon/webhook
SPAYON_RETURN_URL=https://adresse-publique/billing
```

Le point d’entrée public doit transmettre les callbacks bruts vers le serveur local, et le retour doit ramener le navigateur au tableau de bord local en conservant `sessionId`. Une adresse de tunnel est temporaire ; pour l’exploitation en ligne, déployer les routes Spayon et utiliser les URL publiques stables du service.

Redémarrer le serveur après modification des variables. Ouvrir Facturation avec un compte utilisateur ordinaire : le premier compte créé est administrateur et dispose déjà de l’accès, donc ne présente pas de bouton d’achat.

## Parcours et webhook

1. Le navigateur appelle `POST /api/account/spayon/checkout` avec la session du compte connecté. Le prix, la devise et l’identifiant de commande sont fixés par le serveur.
2. Le serveur crée une commande locale puis une session Spayon avec `product_name`, `price`, `currency` et `defaultPaymentMethod: visamaster`. Il charge ensuite les options de la session et effectue lui-même la requête du bouton « Proceed to payment ». Il ne transmet au navigateur que la redirection bancaire obtenue (`epg.unibank.am` pour le terminal actuellement testé). Le client ne voit donc pas l’écran intermédiaire Scoupon. Les données de carte sont saisies directement chez la banque et ne transitent pas par Sherlo.
3. Spayon appelle `POST /api/account/spayon/webhook`. L’adresse est transmise automatiquement dans chaque demande de paiement. Elle doit être accessible publiquement ; pour un serveur local, utiliser un tunnel public.
4. Le serveur vérifie `X-Signature` : HMAC-SHA256 du corps brut, avec le même Client Secret que pour l’authentification. Il vérifie ensuite la commande, l’environnement, la session, le montant et la devise. Seul `paid` active l’accès.
5. L’utilisateur revient sur `/billing?checkout=returned&sessionId=…`. Sherlo consulte le statut Spayon via `POST /api/account/spayon/sync` si nécessaire. Seul le propriétaire de la commande peut effectuer cette vérification.

Les notifications répétées n’ajoutent pas d’années supplémentaires. Un échec reçu après un paiement validé ne retire pas l’accès. `pending`, `failed`, `expired` et un simple retour navigateur ne débloquent rien. Tant que l’accès n’est pas actif, la page Facturation interroge le statut toute seule toutes les 3 secondes. Il n’y a pas de bouton à cliquer pour cela. Quand Spayon marque une session `expired`, Sherlo enregistre `updatedAt` dans `expiredAt` et affiche cette date. Une session expirée peut être remplacée par un nouveau paiement.

Un code promo facultatif, `SPAYON_PROMO_CODE`, est vérifié uniquement sur le serveur. `SPAYON_PROMO_OFF` vaut 55 par défaut : un prix de 59 EUR devient 4 EUR. Le navigateur ne choisit jamais le montant. Le code ne doit pas rester en place après l’essai, car toute personne qui le connaît peut payer le prix réduit.

## Essai et production

En sandbox, effectuer un paiement simulé avec le formulaire hébergé Spayon. Vérifier le message de confirmation et la date de fin d’accès, puis revenir sur la page pour confirmer la persistance. Les commandes sandbox et leurs accès sont isolés de la production.

Pour passer en production, utiliser les identifiants de production et `SPAYON_ENVIRONMENT=production`, avec des URL publiques HTTPS, puis redémarrer. Les variables historiques `STRIPE_*` et `POLAR_*` ne pilotent plus la facturation. Le code ne migre pas les anciens abonnements en droits Spayon et ne résilie pas d’éventuels abonnements Stripe existants ; ceux-ci nécessitent un traitement depuis l’ancien prestataire.

## API pour les autres applications

Une autre application ne contacte jamais Spayon. Elle appelle `https://api.sherlo.co` avec une clé API Sherlo (`X-Api-Key` ou `Authorization: Bearer`), au rôle opérateur ou administrateur, sans restriction de session WhatsApp. Le contrat complet est dans [`API-PAIEMENTS.md`](./API-PAIEMENTS.md).

`POST https://api.sherlo.co/api/pay/checkouts`

```json
{
  "amount": 4,
  "currency": "EUR",
  "productName": "Abonnement Pro",
  "email": "client@example.com",
  "fullName": "Client",
  "reference": "order-1001",
  "returnUrl": "https://mon-application.example/paiement/retour",
  "cancelUrl": "https://mon-application.example/paiement/annule"
}
```

`amount` est en euros : `4` signifie 4,00 €. La réponse contient `url`, l’adresse de la banque uniquement, et `id`. Le navigateur du client est envoyé vers cette adresse. Il ne passe par aucune page Sherlo. `returnUrl` et `cancelUrl` doivent être des adresses HTTPS publiques de l’application appelante. Sherlo y ajoute `payment` et `reference`.

L’application confirme le paiement en relisant Sherlo : `GET https://api.sherlo.co/api/pay/checkouts/{id}` avec la même clé API. La réponse contient `status`, `amount`, `currency`, `paidAt` et `expiredAt`. `status` vaut `paid` quand le paiement est confirmé. Le retour du client sur `returnUrl` ne confirme rien.

Répéter la même `reference` et le même montant renvoie le même paiement. Un montant différent est refusé.

Le nom du produit affiché à la banque est celui envoyé par l’application. Le compte marchand Spayon peut encore afficher son propre nom commercial sur la page bancaire.

## Vérification automatisée

```sh
npm run test:billing
```

Cette commande compile le serveur, teste les contrôles de paiement et la persistance, exerce les vraies routes HTTP Better Auth avec une API Spayon simulée, puis teste l’affichage du parcours de paiement. Aucun paiement réel n’est créé par ces tests.

Documentation officielle : [création de session](https://docs.spayon.io/create-session.html), [signature et retours](https://docs.spayon.io/callbacks.html), [sandbox](https://docs.spayon.io/sandbox/overview.html).

## Accès direct au formulaire bancaire

L’option `defaultPaymentMethod` est documentée, mais le test réel sur ce compte renvoie toujours l’écran Scoupon. Le serveur reproduit donc la requête HTTP de cet écran, sans navigateur automatisé :

- Lecture de `GET /api/public/session/{sessionId}` avec l’origine du site de paiement retourné par l’API.
- Vérification de la commande, du prix de 59 EUR, de la disponibilité du terminal carte et de l’absence de supplément.
- Envoi de `POST /api/public/payments/bank/sessions/{sessionId}` en formulaire, avec le compte client et l’identifiant de l’option bancaire. Les requêtes utilisent `/api/sandbox/public` en sandbox.
- Lecture de la réponse HTTP de redirection, sans ouvrir la banque côté serveur. Le navigateur du client reçoit seulement l’URL bancaire autorisée.

Cette partie suit le fonctionnement public du formulaire Spayon observé en production ; ces routes ne font pas partie de la référence d’API marchand documentée. Une évolution du formulaire ou un autre acquéreur peut nécessiter une adaptation. Si le montant diffère, si le prestataire ajoute des frais, ou si la destination bancaire est inconnue, Sherlo refuse la redirection et ne renvoie pas silencieusement le client vers l’écran intermédiaire.

Les liens vers les conditions de vente et la politique de confidentialité du prestataire restent visibles sur la page Facturation avant le bouton. Les callbacks restent associés au `sessionId` Spayon original : la banque informe Spayon, puis Spayon envoie le webhook signé à Sherlo. Une URL bancaire créée n’est jamais une preuve de paiement.
