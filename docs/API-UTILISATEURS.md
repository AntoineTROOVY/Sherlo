# Documentation API Sherlo

Documentation pour **connecter votre logiciel à Sherlo** via `https://api.sherlo.co`, avec une **clé API créée dans l’application** [app.sherlo.co](https://app.sherlo.co). Tout le reste (connexion à Sherlo, sessions WhatsApp, webhooks) passe par cette clé — rien d’autre à documenter côté auth produit.

| Service | URL |
| -------- | ----- |
| **Application Sherlo** (clés API, sessions, QR) | [https://app.sherlo.co](https://app.sherlo.co) |
| **API REST & temps réel** | `https://api.sherlo.co` |
| **Préfixe REST** | Toutes les routes REST commencent par `/api` |
| **Référence interactive (OpenAPI / Swagger)** | [https://api.sherlo.co/api/docs](https://api.sherlo.co/api/docs) |
| **Schéma OpenAPI (JSON)** | [https://api.sherlo.co/api/docs-json](https://api.sherlo.co/api/docs-json) *(si activé sur votre déploiement)* |

> **Référence détaillée (anglais, champs et exemples complets)** : le fichier interne [`06-api-specification.md`](./06-api-specification.md) décrit chaque endpoint, corps de requête et cas d’erreur. Ce document est la vue **Sherlo** : mêmes routes, URLs de production et guide en français.

---

## Sommaire

1. [Démarrage rapide](#1-démarrage-rapide)
2. [Authentification](#2-authentification)
3. [Votre clé API Sherlo](#3-votre-clé-api-sherlo)
4. [Format des réponses et erreurs](#4-format-des-réponses-et-erreurs)
5. [Identifiants WhatsApp (JID)](#5-identifiants-whatsapp-jid)
6. [Sessions WhatsApp](#6-sessions-whatsapp)
7. [Messages](#7-messages)
8. [Contacts](#8-contacts)
9. [Groupes](#9-groupes)
10. [Chats et présence](#10-chats-et-présence)
11. [Modèles de messages](#11-modèles-de-messages)
12. [Catalogue & canaux](#12-catalogue--canaux)
13. [Étiquettes & statuts](#13-étiquettes--statuts)
14. [Webhooks (événements sortants)](#14-webhooks-événements-sortants)
15. [Temps réel (Socket.IO)](#15-temps-réel-socketio)
16. [Profil du compte WhatsApp](#16-profil-du-compte-whatsapp)
17. [Appels](#17-appels)
18. [Médias (conversion)](#18-médias-conversion)
19. [Règles d’automatisation](#19-règles-dautomatisation)
20. [Recherche](#20-recherche)
21. [Statistiques & audit](#21-statistiques--audit)
22. [Vérifier votre clé API](#22-vérifier-votre-clé-api)
23. [Santé & paramètres](#23-santé--paramètres)
24. [Administration (infra, plugins, intégrations)](#24-administration-infra-plugins-intégrations)
25. [MCP (Model Context Protocol)](#25-mcp-model-context-protocol)
26. [Index complet des endpoints](#26-index-complet-des-endpoints)

---

## 1. Démarrage rapide

1. Connectez-vous à [app.sherlo.co](https://app.sherlo.co).
2. Ouvrez **Clés API** → **Créer une clé** → choisissez un rôle (`operator` suffit pour envoyer des messages) → **copiez la clé** (affichée une seule fois).
3. Utilisez cette clé dans l’en-tête `X-API-Key` sur toutes les requêtes ci-dessous.

### Créer une session et envoyer un message

```bash
# 1. Créer une session (nom unique)
curl -s -X POST "https://api.sherlo.co/api/sessions" \
  -H "X-API-Key: VOTRE_CLE_API" \
  -H "Content-Type: application/json" \
  -d '{"name":"mon-bot"}'

# 2. Démarrer la connexion WhatsApp
curl -s -X POST "https://api.sherlo.co/api/sessions/{sessionId}/start" \
  -H "X-API-Key: VOTRE_CLE_API"

# 3. Récupérer le QR (ou utiliser le pairing par numéro — voir §6)
curl -s "https://api.sherlo.co/api/sessions/{sessionId}/qr" \
  -H "X-API-Key: VOTRE_CLE_API"

# 4. Quand status = "ready", envoyer un SMS
curl -s -X POST "https://api.sherlo.co/api/sessions/{sessionId}/messages/send-text" \
  -H "X-API-Key: VOTRE_CLE_API" \
  -H "Content-Type: application/json" \
  -d '{"chatId":"33612345678@c.us","text":"Bonjour depuis Sherlo !"}'
```

Vous pouvez aussi créer la session et scanner le QR depuis l’app Sherlo ; l’API sert à automatiser (CRM, n8n, backend, etc.).

---

## 2. Authentification

Toute l’API est protégée par la **clé API** que vous avez générée dans Sherlo (voir §3). Pas d’autre mécanisme pour les intégrations.

### Envoyer la clé sur chaque requête

Presque toutes les routes REST exigent cette clé :

```http
X-API-Key: owa_k1_xxxxxxxxxxxxxxxx
```

Alternative équivalente :

```http
Authorization: Bearer owa_k1_xxxxxxxxxxxxxxxx
```

Si les deux sont présents, **`X-API-Key` prime**.

| Règle | Détail |
| ----- | ------ |
| **Jamais dans l’URL** | Les paramètres `?apiKey=` ne sont **pas** acceptés (fuite dans les logs). |
| **Corps JSON** | Ajoutez `Content-Type: application/json` lorsque vous envoyez un body. |
| **Validation** | `POST https://api.sherlo.co/api/auth/validate` avec la clé dans l’en-tête retourne les métadonnées de la clé si elle est valide. |

### Rôles des clés

| Rôle | Droits |
| ---- | ------ |
| `viewer` | Lecture seule (routes sans rôle minimum explicite) |
| `operator` | Lecture + actions WhatsApp (envoi de messages, groupes, webhooks, etc.) |
| `admin` | Tout, y compris gestion des clés API et paramètres sensibles |

Un rôle **supérieur** satisfait une route qui exige un rôle **inférieur** (ex. `admin` passe une route `operator`).

### Restrictions optionnelles

Une clé peut être limitée à :

- **`allowedSessions`** — liste d’UUID de sessions autorisées ;
- **`allowedIps`** — adresses IP sources autorisées ;
- **`allowedChats`** — chats WhatsApp autorisés uniquement (mode très restrictif).

En dehors de la portée → **`403 Forbidden`**. Clé absente, invalide, révoquée ou expirée → **`401 Unauthorized`**.

### Routes publiques (sans clé API)

| Route | Usage |
| ----- | ----- |
| `GET /api/health` | Santé basique |
| `GET /api/health/live` | Sonde liveness (Kubernetes) |
| `GET /api/health/ready` | Sonde readiness (bases de données) |
| `GET /api/infra/health` | Santé infra |

**Métriques Prometheus** : `GET /api/metrics` avec `Authorization: Bearer <METRICS_TOKEN>` (pas la clé API).

**Ingress plugins** : ` /api/ingress/{pluginId}/{instanceId}/*` — authentification propre au plugin (signature HMAC, token, etc.).

---

## 3. Votre clé API Sherlo

La clé API est le **seul identifiant** dont votre application a besoin pour appeler `api.sherlo.co`.

| Étape | Où | Action |
| ----- | --- | ------ |
| 1 | [app.sherlo.co](https://app.sherlo.co) | Connexion à votre compte Sherlo |
| 2 | **Clés API** | **Créer une clé** — nom descriptif (ex. « CRM prod ») |
| 3 | Rôle | `viewer` (lecture), `operator` (WhatsApp + webhooks), `admin` (tout) |
| 4 | Copie | La clé complète n’est montrée **qu’une fois** — enregistrez-la dans un secret manager |
| 5 | Intégration | `X-API-Key: <votre_clé>` sur REST, WebSocket et MCP |

**Création, rotation et révocation** : uniquement dans l’app Sherlo (Clés API). L’API documentée ici ne couvre pas la connexion à Sherlo : vous obtenez une clé dans l’app, puis vous l’utilisez sur `api.sherlo.co`.

Pour tester qu’une clé est valide depuis votre code : `POST https://api.sherlo.co/api/auth/validate` avec la clé dans l’en-tête (voir §22).

---

## 4. Format des réponses et erreurs

### Succès

- **Pas d’enveloppe globale** `{ success, data }` : la réponse JSON est **directement** la ressource ou un **tableau**.
- Listes paginées : parfois un objet `{ messages: [...], total: N }` — voir Swagger pour chaque route.

### Erreurs (forme NestJS)

```json
{
  "statusCode": 404,
  "message": "Session 'xxx' not found",
  "error": "Not Found"
}
```

Codes métier stables possibles dans le body (ex. `SESSION_NAME_TEARDOWN_PENDING`, `SEND_PACING_LIMITED` avec `retryAfterSeconds`, `ENGINE_PAGE_ERROR`, etc.) — voir [`06-api-specification.md`](./06-api-specification.md) §6.2.

### Timestamps

| Contexte | Format |
| -------- | ------ |
| Messages (`timestamp`) | **Nombre** — epoch Unix en **secondes** |
| `createdAt`, `updatedAt`, etc. | **Chaîne ISO-8601** UTC |

### Statuts de session (`status`)

Valeurs en minuscules :  
`created` · `initializing` · `qr_ready` · `authenticating` · `ready` · `disconnected` · `action_required` · `failed`

### Envoi de messages

- `POST .../messages/send-*` (hors bulk) → **`201`** avec `{ messageId, timestamp }` = **accepté par le client WhatsApp**, pas garantie de livraison chez le destinataire.
- Suivre les accusés via webhooks `message.ack` / statut du message, ou WebSocket.
- `POST .../messages/send-bulk` → **`202`** avec un objet batch (`batchId`, etc.).

### Médias (envoi)

Corps **plat** commun (`chatId` + **`url` OU `base64`** + `mimetype` si base64) :

- Taille média max par défaut : **50 MiB** (décodé).
- Corps HTTP max par défaut : **25 MiB** — privilégier `url` pour les gros fichiers.
- Texte : max **4096** caractères ; légende média : max **1024**.

---

## 5. Identifiants WhatsApp (JID)

| Type | Exemple |
| ---- | ------- |
| Contact ( téléphone ) | `33612345678@c.us` |
| Groupe | `120363012345678901@g.us` |
| LID | `xxxxxxxx@lid` |

Utilisez ces identifiants dans `chatId`, paramètres de route et filtres webhook.

---

## 6. Sessions WhatsApp

Base : `https://api.sherlo.co/api/sessions`

| Méthode | Chemin | Description |
| ------- | ------ | ----------- |
| **POST** | `/api/sessions` | Créer une session |
| **GET** | `/api/sessions` | Lister les sessions (`?limit`, `?offset`, `?name`) |
| **GET** | `/api/sessions/stats/overview` | Statistiques multi-sessions |
| **GET** | `/api/sessions/{sessionId}` | Détail d’une session |
| **DELETE** | `/api/sessions/{sessionId}` | Supprimer une session |
| **POST** | `/api/sessions/{sessionId}/start` | Démarrer / connecter WhatsApp |
| **POST** | `/api/sessions/{sessionId}/stop` | Arrêter (sans délier le compte) |
| **POST** | `/api/sessions/{sessionId}/logout` | Déconnexion WhatsApp (délie l’appareil) |
| **POST** | `/api/sessions/{sessionId}/force-kill` | Forcer l’arrêt d’un moteur bloqué |
| **GET** | `/api/sessions/{sessionId}/qr` | QR code (base64 / payload selon réponse) |
| **POST** | `/api/sessions/{sessionId}/pairing-code` | Code à 8 caractères (liaison par numéro) |
| **GET** | `/api/sessions/{sessionId}/config` | Config tunable (autoRejectCalls, reconnexion, …) |
| **PATCH** | `/api/sessions/{sessionId}/config` | Mettre à jour la config |
| **GET** | `/api/sessions/{sessionId}/proxy` | Proxy sortant (identifiants masqués) |
| **PATCH** | `/api/sessions/{sessionId}/proxy` | Configurer le proxy sortant |

Champs utiles en lecture : `phone`, `pushName`, `connectedAt`, `lastActive`, `engineLoaded`, `restriction`, `lastError`.

---

## 7. Messages

Base : `https://api.sherlo.co/api/sessions/{sessionId}/messages`

### Envoi

| Méthode | Chemin | Description |
| ------- | ------ | ----------- |
| **POST** | `.../send-text` | Texte |
| **POST** | `.../send-image` | Image |
| **POST** | `.../send-video` | Vidéo |
| **POST** | `.../send-audio` | Audio / note vocale |
| **POST** | `.../send-document` | Document |
| **POST** | `.../send-sticker` | Sticker |
| **POST** | `.../send-location` | Position |
| **POST** | `.../send-contact` | Carte contact |
| **POST** | `.../send-poll` | Sondage |
| **POST** | `.../send-template` | Modèle enregistré → texte |
| **POST** | `.../send-product` | Produit catalogue *(Baileys)* |
| **POST** | `.../send-bulk` | Envoi massif asynchrone |
| **POST** | `.../reply` | Réponse à un message |
| **POST** | `.../click-button` | Clic bouton WhatsApp Business *(Baileys)* |

### Lecture & actions

| Méthode | Chemin | Description |
| ------- | ------ | ----------- |
| **GET** | `.../` | Historique (`?chatId`, pagination) |
| **GET** | `.../{chatId}/history` | Historique live depuis WhatsApp |
| **GET** | `.../{chatId}/{messageId}/media` | Télécharger le média stocké |
| **GET** | `.../{chatId}/{messageId}/reactions` | Réactions |
| **POST** | `.../edit` | Éditer un message envoyé par ce compte |
| **POST** | `.../delete` | Supprimer un message |
| **POST** | `.../forward` | Transférer |
| **POST** | `.../react` | Réaction emoji |
| **POST** | `.../pin` / `.../unpin` | Épingler / désépingler |
| **POST** | `.../star` | Favori |
| **POST** | `.../vote-poll` | Voter à un sondage |
| **GET** | `.../batch/{batchId}` | Statut d’un envoi bulk |
| **POST** | `.../batch/{batchId}/cancel` | Annuler un bulk en cours |

**Mentions** : fournir `mentions: ["336...@c.us"]` **et** inclure `@336...` dans le texte / légende.

---

## 8. Contacts

Base : `https://api.sherlo.co/api/sessions/{sessionId}/contacts`

| Méthode | Chemin | Description |
| ------- | ------ | ----------- |
| **GET** | `/` | Liste des contacts |
| **GET** | `/{contactId}` | Détail |
| **PUT** | `/{contactId}` | Créer / modifier dans le carnet |
| **DELETE** | `/{contactId}` | Retirer du carnet |
| **GET** | `/check/{number}` | Le numéro est-il sur WhatsApp ? |
| **GET** | `/{contactId}/profile-picture` | URL photo de profil |
| **GET** | `/profile-pictures` | Batch (max 50) |
| **POST** | `/{contactId}/block` | Bloquer |
| **DELETE** | `/{contactId}/block` | Débloquer |
| **GET** | `/blocked` | Liste des bloqués |
| **GET** | `/{contactId}/phone` | Résoudre LID → téléphone (best-effort) |

---

## 9. Groupes

Base : `https://api.sherlo.co/api/sessions/{sessionId}/groups`

| Méthode | Chemin | Description |
| ------- | ------ | ----------- |
| **GET** | `/` | Liste des groupes |
| **POST** | `/` | Créer un groupe |
| **GET** | `/join-info` | Aperçu via code d’invitation |
| **POST** | `/join` | Rejoindre via code |
| **GET** | `/{groupId}` | Infos détaillées |
| **PUT** | `/{groupId}/subject` | Renommer |
| **PUT** | `/{groupId}/description` | Description |
| **GET/PUT/DELETE** | `/{groupId}/picture` | Photo du groupe |
| **GET/PUT** | `/{groupId}/settings` | Annonces, verrouillage, messages éphémères |
| **GET** | `/{groupId}/invite-code` | Lien / code d’invitation |
| **POST** | `/{groupId}/invite-code/revoke` | Révoquer et régénérer |
| **POST/DELETE** | `/{groupId}/participants` | Ajouter / retirer des membres |
| **POST** | `/{groupId}/participants/promote` | Promouvoir admin |
| **POST** | `/{groupId}/participants/demote` | Rétrograder admin |
| **POST** | `/{groupId}/leave` | Quitter |
| **GET** | `/{groupId}/membership-requests` | Demandes d’adhésion |
| **POST** | `.../membership-requests/approve` | Approuver |
| **POST** | `.../membership-requests/reject` | Refuser |

---

## 10. Chats et présence

| Méthode | Chemin | Description |
| ------- | ------ | ----------- |
| **GET** | `/api/sessions/{sessionId}/chats` | Chats actifs |
| **POST** | `.../chats/read` | Marquer lu |
| **POST** | `.../chats/unread` | Marquer non lu |
| **POST** | `.../chats/archive` | Archiver / désarchiver |
| **POST** | `.../chats/mute` | Muet |
| **POST** | `.../chats/pin` | Épingler dans la liste |
| **POST** | `.../chats/typing` | Indicateur « en train d’écrire » |
| **POST** | `.../chats/delete` | Supprimer de la liste |
| **DELETE** | `.../chats/{chatId}/messages` | Vider les messages du chat |
| **PUT** | `.../presence` | Présence globale (en ligne / hors ligne) |
| **POST** | `.../presence/subscribe` | S’abonner à la présence d’un chat |
| **GET** | `.../presence/{chatId}` | Dernière présence connue |

---

## 11. Modèles de messages

Base : `https://api.sherlo.co/api/sessions/{sessionId}/templates`

| Méthode | Chemin | Description |
| ------- | ------ | ----------- |
| **POST** | `/` | Créer un modèle |
| **GET** | `/` | Lister |
| **GET** | `/{id}` | Détail |
| **PUT** | `/{id}` | Modifier |
| **DELETE** | `/{id}` | Supprimer |

Envoi via `POST .../messages/send-template` avec l’identifiant / variables du modèle.

---

## 12. Catalogue & canaux

### Catalogue *(moteur Baileys)*

| Méthode | Chemin |
| ------- | ------ |
| **GET** | `/api/sessions/{sessionId}/catalog` |
| **GET** | `/api/sessions/{sessionId}/catalog/products` |
| **GET** | `/api/sessions/{sessionId}/catalog/products/{productId}` |

### Canaux (newsletters)

Base : `https://api.sherlo.co/api/sessions/{sessionId}/channels`

Création, abonnement (`subscribe`), messages, mute, transfert de propriété, etc. — voir [§26](#26-index-complet-des-endpoints) ou Swagger.

---

## 13. Étiquettes & statuts

### Étiquettes *(WhatsApp Business)*

`https://api.sherlo.co/api/sessions/{sessionId}/labels` — CRUD labels, association aux chats.

### Statuts (stories)

| Méthode | Chemin | Description |
| ------- | ------ | ----------- |
| **GET** | `.../status` | Statuts des contacts |
| **GET** | `.../status/{id}` | Statuts d’un contact |
| **POST** | `.../status/send-text` | Publier texte |
| **POST** | `.../status/send-image` | Image |
| **POST** | `.../status/send-video` | Vidéo |
| **POST** | `.../status/send-voice` | Note vocale |
| **DELETE** | `.../status/{id}` | Supprimer son propre statut |
| **GET** | `.../status/{statusId}/media` | Flux média |

---

## 14. Webhooks (événements sortants)

Sherlo envoie des **POST HTTP** vers votre URL lorsque des événements se produisent.

### Gestion

| Méthode | Chemin | Rôle min. |
| ------- | ------ | --------- |
| **POST** | `/api/sessions/{sessionId}/webhooks` | operator |
| **GET** | `/api/sessions/{sessionId}/webhooks` | operator |
| **GET** | `/api/sessions/{sessionId}/webhooks/{id}` | operator |
| **PUT** | `/api/sessions/{sessionId}/webhooks/{id}` | operator |
| **DELETE** | `/api/sessions/{sessionId}/webhooks/{id}` | operator |
| **POST** | `/api/sessions/{sessionId}/webhooks/{id}/test` | operator |
| **GET** | `/api/webhooks` | operator (toutes sessions visibles) |
| **GET** | `/api/webhooks/delivery-failures` | admin |
| **POST** | `/api/webhooks/delivery-failures/redrive` | admin |

`secret` et `headers` personnalisés sont **écriture seule** (jamais renvoyés en GET).

### Événements disponibles (`events[]` ou `"*"`)

```
message.received    message.sent        message.ack         message.failed
message.revoked     message.reaction    message.edited
session.status      session.qr          session.authenticated   session.disconnected
session.reconnect_loop   session.restriction
presence.update
group.join          group.leave         group.update        group.join_request
call.received       call.accepted       call.rejected       call.missed
status.received
```

Certains événements dépendent du moteur WhatsApp (Baileys vs whatsapp-web.js) — voir la spec détaillée.

### En-têtes de livraison

| En-tête | Description |
| ------- | ----------- |
| `X-OpenWA-Event` | Nom de l’événement |
| `X-OpenWA-Signature` | `sha256=<hex>` HMAC-SHA256 du **corps brut** (si `secret` configuré) |
| `X-OpenWA-Idempotency-Key` | Déduplication |
| `X-OpenWA-Delivery-Id` | ID unique de livraison |
| `X-OpenWA-Retry-Count` | Numéro de tentative |

Vérifiez la signature **avant** de parser le JSON. Exemples : [`docs/examples/webhook-signature-verification.md`](./examples/webhook-signature-verification.md).

Répondez **`2xx`** rapidement après avoir accepté l’événement ; les échecs déclenchent des retries configurables (`retryCount`).

---

## 15. Temps réel (Socket.IO)

| Paramètre | Valeur |
| --------- | ------ |
| **URL** | `https://api.sherlo.co` (TLS → `wss://`) |
| **Namespace** | `/events` |
| **Protocole** | Socket.IO (pas WebSocket brut) |

### Authentification (handshake)

Utilisez **la même clé API** que pour le REST :

1. Recommandé : `auth: { apiKey: '...' }` dans le client Socket.IO  
2. Ou en-tête : `x-api-key: ...`

### Commandes client → serveur

Tout transite par l’événement Socket.IO **`message`**, corps JSON :

```json
{
  "type": "subscribe",
  "sessionId": "uuid-ou-*",
  "events": ["message.received", "session.status"],
  "requestId": "optional-correlation-id"
}
```

Types : `subscribe` · `unsubscribe` · `ping`

### Réponses & événements serveur → client

Également sur **`message`** :

- Accusés : `subscribed`, `unsubscribed`, `pong`, `error` (avec `code`)
- Événements live : `{ "type": "event", "payload": { "event", "sessionId", "data" } }`

### Événements souscriptibles (WebSocket)

```
message.received  message.sent  message.ack  message.revoked  message.reaction  message.edited
session.status  session.qr  session.authenticated  session.disconnected  session.restriction
presence.update  group.*  call.*  status.received
```

`message.failed` et `session.reconnect_loop` sont **webhook uniquement**.

Exemple (JavaScript) :

```javascript
import { io } from 'socket.io-client';

const socket = io('https://api.sherlo.co/events', {
  auth: { apiKey: process.env.SHERLO_API_KEY },
});

socket.on('connect', () => {
  socket.emit('message', {
    type: 'subscribe',
    sessionId: '*',
    events: ['message.received'],
    requestId: '1',
  });
});

socket.on('message', (msg) => {
  if (msg.type === 'event') {
    console.log(msg.payload.event, msg.payload.data);
  }
});
```

---

## 16. Profil du compte WhatsApp

`https://api.sherlo.co/api/sessions/{sessionId}/profile`

| Méthode | Chemin | Description |
| ------- | ------ | ----------- |
| **PUT** | `/name` | Nom affiché |
| **PUT** | `/status` | Texte « à propos » |
| **PUT** | `/picture` | Photo (URL ou base64) |
| **DELETE** | `/picture` | Supprimer la photo |

---

## 17. Appels

| Méthode | Chemin | Description |
| ------- | ------ | ----------- |
| **POST** | `/api/sessions/{sessionId}/calls/link` | Lien d’appel WhatsApp partageable |
| **POST** | `/api/sessions/{sessionId}/calls/{callId}/reject` | Rejeter un appel entrant |

Événements d’appels : webhooks / WebSocket (selon moteur).

---

## 18. Médias (conversion)

Option serveur pour formats compatibles WhatsApp :

| Méthode | Chemin |
| ------- | ------ |
| **GET** | `/api/sessions/{sessionId}/media/convert` |
| **POST** | `.../media/convert/video` |
| **POST** | `.../media/convert/voice` |

---

## 19. Règles d’automatisation

Base : `https://api.sherlo.co/api/sessions/{sessionId}/automation-rules`

CRUD de rècles de **réponse automatique** (autoreply) — déclencheurs et réponses configurables via le body documenté dans Swagger.

---

## 20. Recherche

| Méthode | Chemin | Description |
| ------- | ------ | ----------- |
| **GET** | `/api/search` | Recherche de messages cross-sessions (`?q`, `?sessionId`, `?chatId`, pagination) |

Le fournisseur de recherche actif dépend de la configuration (`builtin-fts` ou plugin).

---

## 21. Statistiques & audit

| Méthode | Chemin | Description |
| ------- | ------ | ----------- |
| **GET** | `/api/stats/overview` | Vue d’ensemble |
| **GET** | `/api/stats/messages` | Séries temporelles messages |
| **GET** | `/api/stats/sessions/{sessionId}` | Stats par session |
| **GET** | `/api/audit` | Journal d’audit (filtres query) |

---

## 22. Vérifier votre clé API

Créer, lister ou révoquer des clés se fait **dans l’app Sherlo** (Clés API), pas via un parcours documenté ici.

Pour vérifier depuis votre backend que la clé configurée est encore valide :

| Méthode | Chemin | Description |
| ------- | ------ | ----------- |
| **POST** | `/api/auth/validate` | Valide la clé envoyée dans `X-API-Key` (ou Bearer) et retourne ses métadonnées (rôle, scopes, expiration) |

```bash
curl -s -X POST "https://api.sherlo.co/api/auth/validate" \
  -H "X-API-Key: VOTRE_CLE_API"
```

---

## 23. Santé & paramètres

| Méthode | Chemin | Auth |
| ------- | ------ | ---- |
| **GET** | `/api/health` | Public |
| **GET** | `/api/health/live` | Public |
| **GET** | `/api/health/ready` | Public |
| **GET** | `/api/settings` | Clé API |
| **GET** | `/api/metrics` | Bearer `METRICS_TOKEN` |

---

## 24. Administration (infra, plugins, intégrations)

Réservé aux déploiements **self-hosted** ou comptes **admin** avec accès infra (sur Sherlo cloud, certaines routes peuvent être désactivées ou restreintes).

### Infrastructure

Préfixe : `/api/infra` — config, export/import de données, stockage, redémarrage, moteurs WhatsApp, etc.

### Plugins

Préfixe : `/api/plugins` — catalogue, installation ZIP/URL, config, activation par session.

### Integration fabric

- Instances : `/api/integration/plugins/{pluginId}/instances`
- Ingress entrant : `/api/ingress/{pluginId}/{instanceId}/{path}`

Voir [`25-integration-fabric.md`](./25-integration-fabric.md).

---

## 25. MCP (Model Context Protocol)

Si activé sur votre instance :

| | |
| - | - |
| **Endpoint** | `POST https://api.sherlo.co/mcp` |
| **Auth** | `X-API-Key` ou `Authorization: Bearer` (obligatoire) |
| **Transport** | Streamable HTTP (stateless) |

Détails des outils et limites : [`24-mcp-integration.md`](./24-mcp-integration.md).

---

## 26. Index complet des endpoints

Toutes les URLs ci-dessous sont relatives à **`https://api.sherlo.co`**.

### Audit

- **GET** `/api/audit` — Journal d’audit avec filtres

### Auth (clé API)

- **POST** `/api/auth/validate` — Vérifier la clé utilisée par votre intégration *(création / révocation : app Sherlo → Clés API)*

### Automation

- **POST** `/api/sessions/{sessionId}/automation-rules` — Créer une règle autoreply
- **GET** `/api/sessions/{sessionId}/automation-rules` — Lister
- **GET** `/api/sessions/{sessionId}/automation-rules/{ruleId}` — Détail
- **PUT** `/api/sessions/{sessionId}/automation-rules/{ruleId}` — Modifier
- **DELETE** `/api/sessions/{sessionId}/automation-rules/{ruleId}` — Supprimer

### Calls

- **POST** `/api/sessions/{sessionId}/calls/{callId}/reject` — Rejeter un appel entrant
- **POST** `/api/sessions/{sessionId}/calls/link` — Lien d’appel partageable

### Catalog

- **GET** `/api/sessions/{sessionId}/catalog` — Infos catalogue (Baileys)
- **GET** `/api/sessions/{sessionId}/catalog/products` — Produits
- **GET** `/api/sessions/{sessionId}/catalog/products/{productId}` — Produit
- **POST** `/api/sessions/{sessionId}/messages/send-product` — Envoyer un produit

### Channels

- **GET** `/api/sessions/{sessionId}/channels` — Canaux abonnés
- **POST** `/api/sessions/{sessionId}/channels` — Créer un canal
- **GET** `/api/sessions/{sessionId}/channels/{channelId}` — Détail canal
- **DELETE** `/api/sessions/{sessionId}/channels/{channelId}` — Se désabonner
- **POST** `/api/sessions/{sessionId}/channels/{channelId}/admins/demote` — Rétrograder admin
- **POST** `/api/sessions/{sessionId}/channels/{channelId}/delete` — Supprimer (propriétaire)
- **GET** `/api/sessions/{sessionId}/channels/{channelId}/messages` — Messages du canal
- **POST** `/api/sessions/{sessionId}/channels/{channelId}/mute` — Muet
- **POST** `/api/sessions/{sessionId}/channels/{channelId}/owner/transfer` — Transférer propriété
- **POST** `/api/sessions/{sessionId}/channels/subscribe` — S’abonner via code

### Contacts

- **GET** `/api/sessions/{sessionId}/contacts` — Liste
- **GET** `/api/sessions/{sessionId}/contacts/{contactId}` — Détail
- **PUT** `/api/sessions/{sessionId}/contacts/{contactId}` — Enregistrer / modifier
- **DELETE** `/api/sessions/{sessionId}/contacts/{contactId}` — Retirer
- **POST** `/api/sessions/{sessionId}/contacts/{contactId}/block` — Bloquer
- **DELETE** `/api/sessions/{sessionId}/contacts/{contactId}/block` — Débloquer
- **GET** `/api/sessions/{sessionId}/contacts/{contactId}/phone` — Résoudre téléphone
- **GET** `/api/sessions/{sessionId}/contacts/{contactId}/profile-picture` — Photo profil
- **GET** `/api/sessions/{sessionId}/contacts/blocked` — Bloqués
- **GET** `/api/sessions/{sessionId}/contacts/check/{number}` — Vérifier numéro WhatsApp
- **GET** `/api/sessions/{sessionId}/contacts/profile-pictures` — Photos (batch ≤50)

### Groups

- **POST** `/api/sessions/{sessionId}/groups` — Créer
- **GET** `/api/sessions/{sessionId}/groups/{groupId}` — Détail
- **PUT** `/api/sessions/{sessionId}/groups/{groupId}/description` — Description
- **GET** `/api/sessions/{sessionId}/groups/{groupId}/invite-code` — Code d’invitation
- **POST** `/api/sessions/{sessionId}/groups/{groupId}/invite-code/revoke` — Révoquer code
- **POST** `/api/sessions/{sessionId}/groups/{groupId}/leave` — Quitter
- **GET** `/api/sessions/{sessionId}/groups/{groupId}/membership-requests` — Demandes adhésion
- **POST** `/api/sessions/{sessionId}/groups/{groupId}/membership-requests/approve` — Approuver
- **POST** `/api/sessions/{sessionId}/groups/{groupId}/membership-requests/reject` — Refuser
- **POST** `/api/sessions/{sessionId}/groups/{groupId}/participants` — Ajouter membres
- **DELETE** `/api/sessions/{sessionId}/groups/{groupId}/participants` — Retirer membres
- **POST** `/api/sessions/{sessionId}/groups/{groupId}/participants/demote` — Rétrograder
- **POST** `/api/sessions/{sessionId}/groups/{groupId}/participants/promote` — Promouvoir admin
- **GET** `/api/sessions/{sessionId}/groups/{groupId}/picture` — Photo
- **PUT** `/api/sessions/{sessionId}/groups/{groupId}/picture` — Définir photo
- **DELETE** `/api/sessions/{sessionId}/groups/{groupId}/picture` — Supprimer photo
- **GET** `/api/sessions/{sessionId}/groups/{groupId}/settings` — Paramètres groupe
- **PUT** `/api/sessions/{sessionId}/groups/{groupId}/settings` — Modifier paramètres
- **PUT** `/api/sessions/{sessionId}/groups/{groupId}/subject` — Nom du groupe
- **POST** `/api/sessions/{sessionId}/groups/join` — Rejoindre via code
- **GET** `/api/sessions/{sessionId}/groups/join-info` — Aperçu invitation

### Health

- **GET** `/api/health` — Santé
- **GET** `/api/health/live` — Liveness
- **GET** `/api/health/ready` — Readiness

### Infrastructure

- **GET** `/api/infra/config` — Lire config infra
- **PUT** `/api/infra/config` — Écrire config (.env)
- **GET** `/api/infra/engines` — Moteurs disponibles
- **GET** `/api/infra/engines/current` — Moteur actif
- **GET** `/api/infra/export-data` — Export données
- **GET** `/api/infra/health` — Santé infra
- **POST** `/api/infra/import-data` — Import données
- **POST** `/api/infra/restart` — Redémarrage
- **GET** `/api/infra/status` — Statut infra
- **GET** `/api/infra/storage/export` — Export fichiers (tar.gz)
- **GET** `/api/infra/storage/files/count` — Nombre de fichiers
- **POST** `/api/infra/storage/import` — Import stockage
- **GET** `/api/infra/update-check` — Vérifier mises à jour

### Integration

- **GET/POST/PUT/PATCH/DELETE** `/api/ingress/{pluginId}/{instanceId}/{path}` — Webhooks entrants plugins
- **POST** `/api/integration/instances/{pluginId}/{instanceId}/redrive` — Rejouer livraisons
- **POST/GET** `/api/integration/plugins/{pluginId}/instances` — Créer / lister instances
- **GET/PATCH/DELETE** `/api/integration/plugins/{pluginId}/instances/{instanceId}` — Instance
- **POST** `/api/integration/plugins/{pluginId}/instances/{instanceId}/regenerate-secret` — Régénérer secret

### Labels

- **GET** `/api/sessions/{sessionId}/labels` — Labels (Business)
- **GET** `/api/sessions/{sessionId}/labels/{labelId}` — Détail label
- **PUT** `/api/sessions/{sessionId}/labels/{labelId}` — Créer / mettre à jour
- **DELETE** `/api/sessions/{sessionId}/labels/{labelId}` — Supprimer
- **GET** `/api/sessions/{sessionId}/labels/{labelId}/chats` — Chats du label
- **GET** `/api/sessions/{sessionId}/labels/chat/{chatId}` — Labels d’un chat
- **POST** `/api/sessions/{sessionId}/labels/chat/{chatId}` — Ajouter label au chat
- **DELETE** `/api/sessions/{sessionId}/labels/chat/{chatId}/{labelId}` — Retirer label

### Media

- **GET** `/api/sessions/{sessionId}/media/convert` — Conversion disponible ?
- **POST** `/api/sessions/{sessionId}/media/convert/video` — Convertir vidéo
- **POST** `/api/sessions/{sessionId}/media/convert/voice` — Convertir audio (Ogg/Opus)

### Messages

*(liste complète — voir §7 ; 30+ routes sous `/api/sessions/{sessionId}/messages`)*

### Metrics

- **GET** `/api/metrics` — Prometheus (token dédié)

### Plugins

- **GET** `/api/plugins` — Liste
- **GET** `/api/plugins/{id}` — Détail
- **DELETE** `/api/plugins/{id}` — Désinstaller
- **PUT** `/api/plugins/{id}/config` — Config globale
- **GET** `/api/plugins/{id}/config-ui` — UI config (iframe)
- **PUT** `/api/plugins/{id}/config/{sessionId}` — Override par session
- **POST** `/api/plugins/{id}/disable` — Désactiver
- **POST** `/api/plugins/{id}/enable` — Activer
- **GET** `/api/plugins/{id}/health` — Santé plugin
- **PUT** `/api/plugins/{id}/sessions` — Sessions activées
- **POST** `/api/plugins/{id}/update` — Mise à jour depuis URL
- **GET** `/api/plugins/catalog` — Catalogue distant
- **POST** `/api/plugins/install` — Install ZIP
- **POST** `/api/plugins/install-url` — Install depuis URL

### Profile

- **PUT** `/api/sessions/{sessionId}/profile/name`
- **PUT** `/api/sessions/{sessionId}/profile/picture`
- **DELETE** `/api/sessions/{sessionId}/profile/picture`
- **PUT** `/api/sessions/{sessionId}/profile/status`

### Search

- **GET** `/api/search`

### Sessions

*(voir §6 ; inclut chats, groups list, config, proxy, qr, start/stop, pairing, presence)*

### Settings

- **GET** `/api/settings`

### Statistics

- **GET** `/api/stats/messages`
- **GET** `/api/stats/overview`
- **GET** `/api/stats/sessions/{sessionId}`

### Status

- **GET** `/api/sessions/{sessionId}/status`
- **GET** `/api/sessions/{sessionId}/status/{id}`
- **DELETE** `/api/sessions/{sessionId}/status/{id}`
- **GET** `/api/sessions/{sessionId}/status/{statusId}/media`
- **POST** `/api/sessions/{sessionId}/status/send-image`
- **POST** `/api/sessions/{sessionId}/status/send-text`
- **POST** `/api/sessions/{sessionId}/status/send-video`
- **POST** `/api/sessions/{sessionId}/status/send-voice`

### Templates

- **POST/GET** `/api/sessions/{sessionId}/templates`
- **GET/PUT/DELETE** `/api/sessions/{sessionId}/templates/{id}`

### Webhooks

- **POST/GET** `/api/sessions/{sessionId}/webhooks`
- **GET/PUT/DELETE** `/api/sessions/{sessionId}/webhooks/{id}`
- **POST** `/api/sessions/{sessionId}/webhooks/{id}/test`
- **GET** `/api/webhooks`
- **GET** `/api/webhooks/delivery-failures`
- **POST** `/api/webhooks/delivery-failures/redrive`

---

## Support & conformité

- Utilisez WhatsApp conformément aux [Conditions d’utilisation de WhatsApp](https://www.whatsapp.com/legal) et aux lois applicables (opt-in, RGPD, etc.).
- Ne partagez jamais vos clés API dans des dépôts publics ou des applications client exposées.
- Pour le détail champ par champ de chaque body JSON, privilégiez **[Swagger](https://api.sherlo.co/api/docs)** ou [`06-api-specification.md`](./06-api-specification.md).

*Documentation Sherlo — générée pour `app.sherlo.co` / `api.sherlo.co`.*
