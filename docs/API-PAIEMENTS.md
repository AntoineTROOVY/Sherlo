# API Paiements Sherlo

Documentation pour **encaisser depuis une autre application** via `https://api.sherlo.co`. La clé API se crée dans [app.sherlo.co](https://app.sherlo.co). L’API WhatsApp est dans un autre document : [`API-UTILISATEURS.md`](./API-UTILISATEURS.md).

| Service | URL |
| ------- | --- |
| **Application Sherlo** (création de la clé) | [https://app.sherlo.co](https://app.sherlo.co) |
| **API paiements** | `https://api.sherlo.co` |
| **Référence interactive** | [https://api.sherlo.co/api/docs](https://api.sherlo.co/api/docs) |

L’application appelante envoie le client sur la page de la banque. Il ne voit aucune page Sherlo. Elle confirme le paiement en relisant Sherlo. Aucune URL de notification n’est demandée.

## Créer la clé

La clé se crée dans le tableau de bord, par le compte administrateur Sherlo.

1. Ouvrez [https://app.sherlo.co/api-keys](https://app.sherlo.co/api-keys). Le menu s’appelle **Clés API**. La page Facturation a le même lien, **Créer une clé API**.
2. Choisissez le rôle **Opérateur**.
3. Ne limitez pas la clé à une session WhatsApp, ni à des chats.
4. Copiez la clé tout de suite. Elle n’est plus affichée ensuite.

La clé a le rôle `operator` ou `admin`, **sans** restriction de session WhatsApp.

```http
X-API-Key: owa_k1_xxxxxxxxxxxxxxxx
```

`Authorization: Bearer` est équivalent. Si les deux sont présents, `X-API-Key` prime.

---

## Ouvrir un paiement

`POST https://api.sherlo.co/api/pay/checkouts`

```bash
curl -s -X POST "https://api.sherlo.co/api/pay/checkouts" \
  -H "X-API-Key: VOTRE_CLE_API" \
  -H "Content-Type: application/json" \
  -d '{
    "amount": 4,
    "currency": "EUR",
    "productName": "Abonnement Pro",
    "email": "client@example.com",
    "fullName": "Client",
    "reference": "order-1001",
    "returnUrl": "https://mon-application.example/paiement/retour",
    "cancelUrl": "https://mon-application.example/paiement/annule"
  }'
```

| Champ | Règle |
| ----- | ----- |
| `amount` | Prix en unités de devise. `4` signifie 4,00 €, pas 4 centimes. Supérieur à 0, au plus 100000, deux décimales maximum. |
| `currency` | Optionnel. Sur sherlo.co la devise est `EUR`. Une autre devise est refusée. |
| `productName` | 1 à 120 caractères. C’est le nom affiché pour ce paiement. |
| `email` | E-mail du payeur. |
| `fullName` | Optionnel, 120 caractères maximum. |
| `reference` | Référence propre à l’application : 1 à 80 caractères parmi lettres, chiffres, `.`, `_` et `-`. |
| `returnUrl` | Page HTTPS publique de l’application, après la banque. |
| `cancelUrl` | Page HTTPS publique de l’application si le payeur annule. |

Sherlo ajoute `payment` et `reference` sur `returnUrl` et `cancelUrl`.

Réponse `201` :

```json
{
  "id": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  "reference": "order-1001",
  "status": "pending",
  "amount": 4,
  "currency": "EUR",
  "url": "https://epg.unibank.am/...",
  "paidAt": null,
  "expiredAt": null
}
```

`url` est l’adresse de la banque. L’application y envoie le navigateur du client.

La même `reference` avec le même montant renvoie le même paiement. Un montant différent sur cette référence répond `409`.

---

## Savoir que le paiement est confirmé

`GET https://api.sherlo.co/api/pay/checkouts/{id}`

```bash
curl -s "https://api.sherlo.co/api/pay/checkouts/7c9e6679-7425-40de-944b-e07fc1f90ae7" \
  -H "X-API-Key: VOTRE_CLE_API"
```

| `status` | Signification |
| -------- | ------------- |
| `pending` | Le paiement est ouvert. `url` permet d’y retourner. |
| `paid` | Le paiement est confirmé. `paidAt` est la date. |
| `failed` | Le paiement a échoué. |
| `expired` | La session a expiré. `expiredAt` est la date. |

Seul `status: "paid"` confirme le paiement. L’arrivée du client sur `returnUrl` ne confirme rien. La réponse ne contient ni l’e-mail ni un secret.

---

## Erreurs

| Code | Cas |
| ---- | --- |
| `400` | Champ invalide, devise différente de `EUR`, ou adresse de retour qui n’est pas une HTTPS publique. |
| `401` | Clé absente ou invalide. |
| `403` | Clé `viewer`, ou clé limitée à une session WhatsApp. |
| `404` | `id` inconnu. |
| `409` | Cette `reference` existe déjà pour un autre montant. |
| `502` | La page bancaire n’a pas pu être ouverte. Réessayer la même `reference`. |
| `503` | Le paiement n’est pas configuré sur ce serveur. |

Ces paiements ne débloquent pas l’accès au tableau de bord Sherlo.
