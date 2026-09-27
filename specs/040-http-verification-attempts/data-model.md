# Transient model
Attempt: client(browser|terminal), protocol(http|https), URL, startedAt, nonce.
Slot key: client:protocol. Four slots; retry replaces only that slot.
Result: waiting -> timedOut -> verified(status,eventId), with late response accepted
until replaced. Proxy identity change/unknown/unmount clears every slot.
No persistence or evidence mutation.
