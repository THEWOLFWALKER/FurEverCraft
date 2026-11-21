# Testing Premise Rule

Every test must be grounded in a documented contract or observable behavior. Do not make tests pass by assuming fixture constants are production facts, by testing a function against its own hard-coded return value, or by asserting unsupported protocol/OS behavior. When a test fails, first verify that its premise matches the contract and implementation boundary; then fix the implementation or the test premise explicitly. Never weaken assertions, silently skip, or label a fixture result as real-client proof.
