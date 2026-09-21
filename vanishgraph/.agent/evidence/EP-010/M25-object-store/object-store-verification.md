# The object-store dependency, verified end to end (EP-010 M25)

SPEC-007 section 7.2 declares the object-store probe as "HeadBucket plus a signed GetObject of a probe key that must
return the expected digest". That action was executed against the repository's own disposable object store, and the
probe both PASSED and REFUSED a wrong digest:

    create bucket -> 409   (already present: the container was recreated with its volume, so no data was lost)
    put object    -> 200
    probe         -> HeadBucket and signed GetObject verified for vanishgraph-probe/readiness/probe-object
    wrong digest  -> refused: MISCONFIGURED

## The configuration the running service needs (all values are local test material, never credentials of record)

    endpoint          http://127.0.0.1:59000
    bucket            vanishgraph-probe
    region            us-east-1
    accessKeyId       vgprobe
    probeKey          readiness/probe-object
    payload           vanishgraph object-store probe payload
    expectedDigest    870ca51706812c52d2360d17a64dfe68edff9c6a475eb4098c9c24937b031561

## What this proves, and what it does not

It proves the declared object-store action is PERFORMABLE in this environment and that the probe is DISCRIMINATING:
the same code path that returns PASS on the correct object returns MISCONFIGURED when the expected digest is wrong, so
an object store serving substituted content cannot pass.

It does NOT prove the object store holds anything the product needs, and it is not a production claim: this is the
disposable local store, and the configuration above belongs to the smoke environment rather than to a deployment.

## Environment note (why this took several rounds)

The container had lost its ACTIVE port binding while still declaring it in HostConfig
(9000/tcp -> 59000), so docker port printed nothing and 59000 was closed; a stop/start did not restore it. The
container was recreated from the same image with the same named volume and the same MINIO_ROOT_* environment, which
restored the mapping and preserved the bucket and the probe user.
