# Data Processing Agreement — EU Cloud Deployment

**IMPORTANT: This is a template. Have a lawyer review and customise before use.
It is modelled on Notion's and Linear's public DPAs as a starting point.**

---

**DATA PROCESSING AGREEMENT**

This Data Processing Agreement ("DPA") is entered into between:

**Controller:** [CUSTOMER LEGAL NAME], a [JURISDICTION] company, registered at [ADDRESS] ("Controller" or "Customer")

**Processor:** OneNomad LLC, a Delaware company, registered at [ADDRESS] ("Processor" or "przm")

and forms part of the przm cortex Cloud Business subscription agreement ("Agreement") between the parties.

---

## 1. Definitions

**"Personal Data"** has the meaning given in GDPR Article 4(1).

**"Processing"** has the meaning given in GDPR Article 4(2).

**"GDPR"** means Regulation (EU) 2016/679 of the European Parliament and of the Council.

**"UK GDPR"** means the GDPR as retained in UK law by the European Union (Withdrawal) Act 2018.

**"EU Region"** means the przm cortex Cloud deployment hosted in the Frankfurt, Germany data center (DigitalOcean `fra1` region), with database storage in the AWS `eu-central-1` (Frankfurt) region via Neon.

**"Sub-processor"** means any third party engaged by Processor to process Personal Data under this DPA.

---

## 2. Subject Matter and Duration

2.1 This DPA applies to the Processing of Personal Data by Processor on behalf of Controller in connection with the przm cortex Cloud Business service.

2.2 This DPA commences on the Effective Date of the Agreement and continues until termination of the Agreement.

---

## 3. Nature and Purpose of Processing

3.1 **Purpose:** Provision of the przm cortex workspace-knowledge assistant service, including ingestion and retrieval of documents, meeting notes, and code repositories provided by the Controller.

3.2 **Types of Personal Data:** Names, email addresses, and any personal data contained within documents, files, or repositories that the Controller elects to ingest into cortex.

3.3 **Categories of Data Subjects:** The Controller's employees and contractors who use the cortex service.

---

## 4. Data Residency — EU Commitment

4.1 **Storage location:** All Personal Data processed under this DPA is stored exclusively in the EU Region. No Atlantic crossing of Personal Data will occur.

4.2 **Compute location:** All processing (ingestion, search, retrieval) occurs on Processor's Frankfurt Droplet (`fra1`). Embedding inference runs locally on the Frankfurt Droplet; no Personal Data is sent to third-party LLM APIs unless the Controller has explicitly enabled an external model provider in their cortex configuration.

4.3 **Database:** The Processor uses Neon (Neon Inc.) as database sub-processor. The EU cortex deployment uses a Neon project provisioned in `eu-central-1` (Frankfurt, Germany). The Controller's data is logically isolated via row-level security (tenant-scoped Postgres policies).

4.4 **Access service:** The przm-access identity service operates from the US-East region for token issuance only. It does not store or process cortex workspace data. Tokens include a cryptographically signed `region=eu` claim; the EU cortex enforces that only EU-scoped tokens are accepted.

---

## 5. Controller's Instructions

5.1 Processor shall process Personal Data only on documented instructions from Controller, unless required by applicable law.

5.2 Controller's instructions are: (a) process Personal Data to provide the cortex service, (b) store and process exclusively in the EU Region, (c) delete Personal Data within 30 days of a Controller deletion request.

---

## 6. Sub-processors

6.1 Controller grants general authorisation to use the sub-processors listed in Schedule A.

6.2 Processor shall notify Controller of any intended addition or replacement of a sub-processor at least 30 days before the change takes effect. Controller may object within 14 days; failure to object constitutes acceptance.

---

## 7. Security

7.1 Processor shall implement and maintain appropriate technical and organisational measures to protect Personal Data against accidental or unlawful destruction, loss, alteration, unauthorised disclosure or access, including:

- Encryption at rest (AES-256 via Neon default)
- Encryption in transit (TLS 1.2+ via Caddy)
- Access controls (row-level security; role-based access via przm-access)
- Audit logging of all access and modification events

7.2 Processor maintains and follows the incident response procedure at `docs/runbooks/INCIDENT-RESPONSE.md`.

---

## 8. Data Breach Notification

8.1 In the event of a Personal Data breach, Processor shall notify Controller without undue delay and, where feasible, within 72 hours of becoming aware of the breach.

8.2 Notification shall include: nature of the breach, categories and approximate numbers of data subjects and records, likely consequences, and measures taken or proposed.

---

## 9. Data Subject Rights

9.1 Processor shall assist Controller in fulfilling its obligations to respond to requests from data subjects exercising their rights under GDPR Articles 15–22 (access, rectification, erasure, restriction, portability, objection).

9.2 Processor shall forward any data subject request received directly to Controller within 5 business days.

---

## 10. Deletion and Return

10.1 Upon termination of the Agreement, or upon written request, Processor shall delete or return all Personal Data within 30 days and certify deletion in writing.

10.2 Processor may retain Personal Data longer where required by applicable law, in which case Processor shall inform Controller of the retention and the legal basis.

---

## 11. Audit Rights

11.1 Processor shall make available to Controller all information necessary to demonstrate compliance with this DPA, and shall allow for and contribute to audits conducted by Controller or a mandated auditor, subject to reasonable notice (minimum 30 days) and confidentiality obligations.

11.2 Once SOC 2 Type 2 attestation is obtained by Processor, provision of the attestation report shall satisfy audit obligations in respect of the controls covered by the report.

---

## 12. International Transfers

12.1 Processor commits not to transfer Personal Data outside the European Economic Area or the United Kingdom without: (a) an adequacy decision, (b) Standard Contractual Clauses (Module 2 or 3 as applicable), or (c) another valid transfer mechanism under GDPR Chapter V.

12.2 The access service token issuance (US-East) does not involve a transfer of Personal Data — no workspace content crosses the Atlantic. See Section 4.4.

---

## Schedule A — Sub-processors (EU Region)

| Sub-processor | Role | Location | DPA / documentation |
|---|---|---|---|
| DigitalOcean, LLC | Compute (Frankfurt Droplet) | Frankfurt, Germany (`fra1`) | https://www.digitalocean.com/legal/data-processing-agreement |
| Neon Inc. | Postgres database | Frankfurt, Germany (`eu-central-1`) | https://neon.tech/dpa |
| Let's Encrypt / ISRG | TLS certificate issuance | USA | No personal data transferred (domain validation only) |
| [LLM provider — if enabled] | Embedding inference | [See provider DPA] | Customer must enable; disabled by default |

---

## Signatures

**Controller**

Name: ___________________________
Title: ___________________________
Date: ___________________________
Signature: ___________________________

**Processor (OneNomad LLC)**

Name: Matt Stvartak
Title: Founder
Date: ___________________________
Signature: ___________________________

---

*Template version: 2026-05-28. This document is not legal advice. Engage qualified legal counsel before executing.*
