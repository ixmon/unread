# WAF COUNT rules — cost note (live, no BLOCK)

ACL: `unread-atlas-search-waf` (CloudFront / global, us-east-1)
ID: `c3a34193-8c91-4310-99df-88c5d1bac234`

COUNT-only rules added for Miami spike / crawler visibility (no BLOCK):
- pri 10: `unread-count-seo-crawlers` action=['Count']
- pri 11: `unread-count-wp-probes` action=['Count']
- pri 12: `unread-count-ua-t-pages-120` action=['Count']

## Cost
- AWS WAF Web ACL: ~$5/mo flat.
- Rules: ~$1/mo per rule (these three COUNT rules ≈ $3/mo).
- Requests: $0.60 per million analyzed. COUNT does not add Challenge/CAPTCHA fees.
- CloudWatch metrics for custom rules: free tier usually covers; expect pennies unless metrics flood.
- **No BLOCK** → no false-positive user impact; safe to leave while measuring.

Revisit after a week of Miami/SEO metrics: promote to Challenge only with Hayden OK.
