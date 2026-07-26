//! Shared, checked resource accounting for official adapter runtimes.
//!
//! The ledger deliberately accounts logical ownership rather than allocator
//! implementation details.  Adapter runtimes can therefore expose the same
//! deterministic snapshot on native and WebAssembly targets.

use serde::{Deserialize, Serialize};

use crate::error::{ErrorCode, Result, TabularkError};

const CATEGORY_COUNT: usize = 5;

/// One ownership class in the adapter runtime memory ledger.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ResourceCategory {
    /// Source indexes, schemas, and other state retained until a handle closes.
    Persistent,
    /// Parser/decoder state retained only while an operation is active.
    ActiveOperation,
    /// Worker ingress and transferable output buffers owned by the adapter.
    IngressOutput,
    /// Reclaimable checkpoints, pages, row groups, tiles, or record blocks.
    NativeCache,
    /// Buffers already transferred to and owned by the caller.
    CallerOwned,
}

impl ResourceCategory {
    const fn index(self) -> usize {
        match self {
            Self::Persistent => 0,
            Self::ActiveOperation => 1,
            Self::IngressOutput => 2,
            Self::NativeCache => 3,
            Self::CallerOwned => 4,
        }
    }

    const fn name(self) -> &'static str {
        match self {
            Self::Persistent => "persistent",
            Self::ActiveOperation => "active-operation",
            Self::IngressOutput => "ingress-output",
            Self::NativeCache => "native-cache",
            Self::CallerOwned => "caller-owned",
        }
    }

    const fn is_runtime_owned(self) -> bool {
        !matches!(self, Self::CallerOwned)
    }
}

/// Immutable resource evidence returned by an adapter runtime.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceSnapshot {
    /// Configured upper bound for runtime-owned bytes.
    pub budget_bytes: u64,
    /// Currently charged runtime-owned bytes.
    pub runtime_owned_bytes: u64,
    /// Highest runtime-owned charge observed since construction/reset.
    pub high_water_bytes: u64,
    /// State retained until its source/table handle closes.
    pub persistent_bytes: u64,
    /// State retained by active operations.
    pub active_operation_bytes: u64,
    /// Adapter-owned ingress and output buffers.
    pub ingress_output_bytes: u64,
    /// Reclaimable native cache state.
    pub native_cache_bytes: u64,
    /// Bytes transferred to callers, reported as telemetry but not admitted
    /// against the adapter's runtime-owned budget.
    pub caller_owned_bytes: u64,
    /// Total native-cache bytes reclaimed by the one-retry admission policy.
    pub reclaimed_native_cache_bytes: u64,
    /// Current WebAssembly linear-memory size in 64 KiB pages, or zero for a
    /// native runtime snapshot.
    pub wasm_memory_pages: u64,
    /// Highest WebAssembly linear-memory page count observed by this ledger.
    pub wasm_memory_high_water_pages: u64,
}

/// Checked, deterministic accounting shared by the official runtimes.
#[derive(Clone, Debug)]
pub struct ResourceLedger {
    budget_bytes: u64,
    charged: [u64; CATEGORY_COUNT],
    high_water_bytes: u64,
    reclaimed_native_cache_bytes: u64,
    wasm_memory_pages: u64,
    wasm_memory_high_water_pages: u64,
}

impl ResourceLedger {
    /// Creates an empty ledger with a non-zero runtime-owned budget.
    pub fn new(budget_bytes: u64) -> Result<Self> {
        if budget_bytes == 0 {
            return Err(TabularkError::new(
                ErrorCode::InvalidArgument,
                "resource ledger budget must be greater than zero",
            ));
        }
        Ok(Self {
            budget_bytes,
            charged: [0; CATEGORY_COUNT],
            high_water_bytes: 0,
            reclaimed_native_cache_bytes: 0,
            wasm_memory_pages: 0,
            wasm_memory_high_water_pages: 0,
        })
    }

    /// Charges bytes to one class. If runtime-owned admission would fail,
    /// native cache is cleared and admission is attempted exactly once more.
    ///
    /// Returns how many cache bytes were reclaimed by this admission.
    pub fn admit(&mut self, category: ResourceCategory, bytes: u64) -> Result<u64> {
        if !category.is_runtime_owned() {
            self.add_unbounded(category, bytes)?;
            return Ok(0);
        }

        if self.can_admit(bytes)? {
            self.add_unbounded(category, bytes)?;
            return Ok(0);
        }

        let reclaimed = self.clear_native_cache()?;
        if !self.can_admit(bytes)? {
            return Err(self.limit_error(category, bytes)?);
        }
        self.add_unbounded(category, bytes)?;
        Ok(reclaimed)
    }

    /// Releases a prior charge. Under-release is rejected instead of silently
    /// corrupting later resource evidence.
    pub fn release(&mut self, category: ResourceCategory, bytes: u64) -> Result<()> {
        let charged = &mut self.charged[category.index()];
        *charged = charged.checked_sub(bytes).ok_or_else(|| {
            TabularkError::new(
                ErrorCode::RuntimeFailure,
                "resource ledger release exceeds the charged byte count",
            )
            .with_detail("resource", category.name())
            .with_detail("chargedBytes", *charged)
            .with_detail("releaseBytes", bytes)
        })?;
        Ok(())
    }

    /// Replaces one category's charge using checked release/admission rules.
    /// A failed replacement leaves the previous charge intact.
    pub fn replace(&mut self, category: ResourceCategory, bytes: u64) -> Result<u64> {
        let previous = self.charged[category.index()];
        if previous == bytes {
            return Ok(0);
        }
        self.charged[category.index()] = 0;
        match self.admit(category, bytes) {
            Ok(reclaimed) => Ok(reclaimed),
            Err(error) => {
                self.charged[category.index()] = previous;
                Err(error)
            }
        }
    }

    /// Explicitly clears all reclaimable native cache state.
    pub fn clear_native_cache(&mut self) -> Result<u64> {
        let index = ResourceCategory::NativeCache.index();
        let reclaimed = std::mem::take(&mut self.charged[index]);
        self.reclaimed_native_cache_bytes = self
            .reclaimed_native_cache_bytes
            .checked_add(reclaimed)
            .ok_or_else(|| {
                TabularkError::new(
                    ErrorCode::ResourceLimit,
                    "resource ledger reclaimed-byte counter overflows",
                )
            })?;
        Ok(reclaimed)
    }

    /// Releases all live ownership while retaining lifetime high-water evidence.
    pub fn release_all(&mut self) {
        self.charged = [0; CATEGORY_COUNT];
    }

    /// Records the current WebAssembly linear-memory page count. Page memory
    /// cannot shrink in MVP WebAssembly, so the separate high-water field is
    /// retained even when a host reports a lower replacement memory instance.
    pub fn observe_wasm_memory_pages(&mut self, pages: u64) {
        self.wasm_memory_pages = pages;
        self.wasm_memory_high_water_pages = self.wasm_memory_high_water_pages.max(pages);
    }

    /// Returns an immutable snapshot suitable for private test evidence.
    pub fn snapshot(&self) -> ResourceSnapshot {
        ResourceSnapshot {
            budget_bytes: self.budget_bytes,
            runtime_owned_bytes: self.runtime_owned_bytes().unwrap_or(u64::MAX),
            high_water_bytes: self.high_water_bytes,
            persistent_bytes: self.charged[ResourceCategory::Persistent.index()],
            active_operation_bytes: self.charged[ResourceCategory::ActiveOperation.index()],
            ingress_output_bytes: self.charged[ResourceCategory::IngressOutput.index()],
            native_cache_bytes: self.charged[ResourceCategory::NativeCache.index()],
            caller_owned_bytes: self.charged[ResourceCategory::CallerOwned.index()],
            reclaimed_native_cache_bytes: self.reclaimed_native_cache_bytes,
            wasm_memory_pages: self.wasm_memory_pages,
            wasm_memory_high_water_pages: self.wasm_memory_high_water_pages,
        }
    }

    fn add_unbounded(&mut self, category: ResourceCategory, bytes: u64) -> Result<()> {
        let charged = &mut self.charged[category.index()];
        *charged = charged.checked_add(bytes).ok_or_else(|| {
            TabularkError::new(
                ErrorCode::ResourceLimit,
                "resource ledger category byte count overflows",
            )
            .with_detail("resource", category.name())
        })?;
        if category.is_runtime_owned() {
            self.high_water_bytes = self.high_water_bytes.max(self.runtime_owned_bytes()?);
        }
        Ok(())
    }

    fn can_admit(&self, bytes: u64) -> Result<bool> {
        Ok(self
            .runtime_owned_bytes()?
            .checked_add(bytes)
            .is_some_and(|required| required <= self.budget_bytes))
    }

    fn runtime_owned_bytes(&self) -> Result<u64> {
        self.charged[..ResourceCategory::CallerOwned.index()]
            .iter()
            .try_fold(0_u64, |total, bytes| {
                total.checked_add(*bytes).ok_or_else(|| {
                    TabularkError::new(
                        ErrorCode::ResourceLimit,
                        "resource ledger runtime-owned byte count overflows",
                    )
                })
            })
    }

    fn limit_error(&self, category: ResourceCategory, bytes: u64) -> Result<TabularkError> {
        let used = self.runtime_owned_bytes()?;
        let required = used.checked_add(bytes).ok_or_else(|| {
            TabularkError::new(
                ErrorCode::ResourceLimit,
                "resource ledger admission byte count overflows",
            )
        })?;
        Ok(TabularkError::new(
            ErrorCode::ResourceLimit,
            "adapter runtime exceeds its configured resource budget",
        )
        .with_detail("resource", category.name())
        .with_detail("requiredBytes", required)
        .with_detail("availableBytes", self.budget_bytes.saturating_sub(used))
        .with_detail("budgetBytes", self.budget_bytes))
    }
}

#[cfg(test)]
mod tests {
    use super::{ResourceCategory, ResourceLedger};
    use crate::ErrorCode;

    #[test]
    fn admits_by_category_and_excludes_caller_owned_telemetry() {
        let mut ledger = ResourceLedger::new(100).expect("ledger");
        ledger
            .admit(ResourceCategory::Persistent, 40)
            .expect("persistent");
        ledger
            .admit(ResourceCategory::CallerOwned, 1_000)
            .expect("caller telemetry");

        let snapshot = ledger.snapshot();
        assert_eq!(snapshot.runtime_owned_bytes, 40);
        assert_eq!(snapshot.caller_owned_bytes, 1_000);
        assert_eq!(snapshot.high_water_bytes, 40);
    }

    #[test]
    fn clears_native_cache_once_before_rejecting_admission() {
        let mut ledger = ResourceLedger::new(100).expect("ledger");
        ledger
            .admit(ResourceCategory::Persistent, 60)
            .expect("persistent");
        ledger
            .admit(ResourceCategory::NativeCache, 30)
            .expect("cache");
        assert_eq!(
            ledger
                .admit(ResourceCategory::ActiveOperation, 35)
                .expect("reclaimed admission"),
            30
        );

        let snapshot = ledger.snapshot();
        assert_eq!(snapshot.native_cache_bytes, 0);
        assert_eq!(snapshot.active_operation_bytes, 35);
        assert_eq!(snapshot.reclaimed_native_cache_bytes, 30);

        let error = ledger
            .admit(ResourceCategory::IngressOutput, 6)
            .expect_err("budget exhausted");
        assert_eq!(error.code(), ErrorCode::ResourceLimit);
    }

    #[test]
    fn rejects_overflow_and_under_release_without_mutating_evidence() {
        let mut ledger = ResourceLedger::new(u64::MAX).expect("ledger");
        ledger
            .admit(ResourceCategory::CallerOwned, u64::MAX)
            .expect("maximum telemetry");
        let error = ledger
            .admit(ResourceCategory::CallerOwned, 1)
            .expect_err("overflow");
        assert_eq!(error.code(), ErrorCode::ResourceLimit);
        assert_eq!(ledger.snapshot().caller_owned_bytes, u64::MAX);

        let error = ledger
            .release(ResourceCategory::Persistent, 1)
            .expect_err("under-release");
        assert_eq!(error.code(), ErrorCode::RuntimeFailure);
    }

    #[test]
    fn records_wasm_page_high_water_independently_from_logical_bytes() {
        let mut ledger = ResourceLedger::new(100).expect("ledger");
        ledger.observe_wasm_memory_pages(12);
        ledger.observe_wasm_memory_pages(9);

        let snapshot = ledger.snapshot();
        assert_eq!(snapshot.wasm_memory_pages, 9);
        assert_eq!(snapshot.wasm_memory_high_water_pages, 12);
        assert_eq!(snapshot.runtime_owned_bytes, 0);
    }
}
