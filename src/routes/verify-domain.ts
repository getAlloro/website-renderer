import { Request, Response } from 'express';
import { getProjectByHostname, isPendingOrRedirectDomain } from '../services/project.service';
import { getDb } from '../lib/db';

export async function verifyDomainRoute(req: Request, res: Response): Promise<void> {
  const domain = req.query.domain as string;

  if (!domain) {
    res.status(400).end();
    return;
  }

  // Check if it's a *.sites.getalloro.com subdomain
  const subdomainMatch = domain.match(/^([^.]+)\.sites\./);
  if (subdomainMatch) {
    const project = await getProjectByHostname(subdomainMatch[1]);
    if (project) {
      res.status(200).end();
      return;
    }
    res.status(404).end();
    return;
  }

  // Check if domain exists as a custom domain (primary or alt) — existence in DB is sufficient for cert provisioning
  const project = await getDb()('projects')
    .where(function () {
      this.where('custom_domain', domain).orWhere('custom_domain_alt', domain);
    })
    .first();

  if (project) {
    res.status(200).end();
    return;
  }

  // Domain switch: a pending new domain needs a certificate before promotion
  // (the site serves on it as soon as DNS points here), and an old domain kept
  // as a redirect needs one to answer https:// with the 301. Same existence-only
  // semantics as the check above.
  if (await isPendingOrRedirectDomain(domain)) {
    res.status(200).end();
    return;
  }

  res.status(404).end();
}
