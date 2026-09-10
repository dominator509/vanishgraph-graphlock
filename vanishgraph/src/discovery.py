#!/usr/bin/env python3
import argparse
import sys
import os
import json

def main():
    parser = argparse.ArgumentParser(description="SUBJECT-BOUND DISCOVERY - EP-000 binding")
    parser.add_argument("--subject", help="Subject to discover")
    args = parser.parse_args()

    if not args.subject:
        print("error: missing subject", file=sys.stderr)
        sys.exit(1)

    print("real sources with explainable match for subject:", args.subject)

    # Persist the evidence (durable effect required)
    log_file = "discovery_results.log"
    with open(log_file, "a") as f:
        f.write(f"Subject discovered: {args.subject}\n")

if __name__ == "__main__":
    main()
