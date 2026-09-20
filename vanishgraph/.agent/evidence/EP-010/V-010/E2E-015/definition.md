# E2E-015 SOURCE: E2E-ImportExportPortabilityTesting.md

13. Import / Export / Data Portability Round-Trip Testing

For products that own customer data:

Create a realistic dataset:

A

Export it:

A -> export

Delete/reset environment.

Import it:

export -> B

Then assert:

semantic_hash(A) == semantic_hash(B)

Test:

* large exports
* malformed import
* old-version export
* new-version import
* partial import
* duplicate import
* attachments
* relationships
* permissions
* audit history
* Unicode
* timestamps

This also becomes an excellent backup integrity test.

---

