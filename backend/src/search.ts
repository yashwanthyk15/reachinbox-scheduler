import { Client } from "@elastic/elasticsearch";
import { config } from "./config";

export const searchClient = new Client({ node: config.ELASTICSEARCH_URL });
const indexName = "scheduled-emails";

export interface SearchableEmail {
  id: string;
  userId: string;
  to: string;
  subject: string;
  status: string;
  scheduledAt: Date;
  sentAt: Date | null;
  senderEmail: string;
}

export async function indexEmails(emails: SearchableEmail[]): Promise<void> {
  for (let offset = 0; offset < emails.length; offset += 500) {
    const batch = emails.slice(offset, offset + 500);
    const operations = batch.flatMap((email) => [
      { index: { _id: email.id } },
      {
        id: email.id,
        userId: email.userId,
        to: email.to,
        subject: email.subject,
        status: email.status,
        scheduledAt: email.scheduledAt,
        sentAt: email.sentAt,
        senderEmail: email.senderEmail,
      },
    ]);
    const response = await searchClient.bulk({ index: indexName, refresh: "wait_for", operations });
    if (response.errors) throw new Error("Elasticsearch rejected one or more email index records.");
  }
}

export async function indexEmail(email: SearchableEmail): Promise<void> {
  return indexEmails([email]);
}

export async function searchEmails(userId: string, query: string) {
  const result = await searchClient.search({
    index: indexName,
    query: {
      bool: {
        filter: [{ term: { "userId.keyword": userId } }],
        must: [{
          multi_match: {
            query,
            fields: ["to^2", "subject", "senderEmail", "status"],
            type: "bool_prefix",
          },
        }],
      },
    },
    sort: [{ scheduledAt: "desc" }],
    size: 100,
  });
  return result.hits.hits.map((hit) => hit._source);
}