import type { Mock } from "vitest";

// Vitest 4 types a bare `vi.fn()` (and so `ReturnType<typeof vi.fn>`) as
// Mock<Procedure | Constructable>, which is neither callable nor assignable to a typed
// function slot. Tests that hold a loosely typed mock use this instead.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyMock = Mock<(...args: any[]) => any>;
