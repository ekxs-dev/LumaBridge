use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const HEVC_NAL_DV_RPU: u8 = 62;
pub const COMPACT_DOVI_FLOAT32_COUNT: usize = 256;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum LumaWasmError {
    #[error("invalid HEVC NAL data")]
    InvalidHevc,
    #[error("invalid RPU data")]
    InvalidRpu,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct NalUnit {
    pub nal_type: u8,
    pub offset: usize,
    pub size: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RpuNal {
    pub index: usize,
    pub nal_type: u8,
    pub offset: usize,
    pub size: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CompactDoviMetadata {
    pub nonlinear_offset: [f32; 3],
    pub nonlinear_matrix: [f32; 9],
    pub linear_matrix: [f32; 9],
    pub source_min_pq: f32,
    pub source_max_pq: f32,
}

impl Default for CompactDoviMetadata {
    fn default() -> Self {
        Self {
            nonlinear_offset: [0.0; 3],
            nonlinear_matrix: [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0],
            linear_matrix: [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0],
            source_min_pq: 0.0,
            source_max_pq: 1.0,
        }
    }
}

pub fn nal_type(header_byte: u8) -> u8 {
    (header_byte >> 1) & 0x3f
}

pub fn parse_annex_b(data: &[u8]) -> Result<Vec<NalUnit>, LumaWasmError> {
    let mut starts = Vec::<(usize, usize)>::new();
    let mut i = 0;
    while i + 3 < data.len() {
        if data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1 {
            starts.push((i, 3));
            i += 3;
        } else if i + 4 < data.len() && data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 0 && data[i + 3] == 1 {
            starts.push((i, 4));
            i += 4;
        } else {
            i += 1;
        }
    }

    if starts.is_empty() {
        return Err(LumaWasmError::InvalidHevc);
    }

    let mut units = Vec::new();
    for (index, (start, prefix)) in starts.iter().enumerate() {
        let offset = start + prefix;
        let end = starts.get(index + 1).map(|next| next.0).unwrap_or(data.len());
        if offset + 2 <= end {
            units.push(NalUnit {
                nal_type: nal_type(data[offset]),
                offset,
                size: end - offset,
            });
        }
    }

    Ok(units)
}

pub fn parse_length_prefixed(data: &[u8], length_size: usize) -> Result<Vec<NalUnit>, LumaWasmError> {
    if !(1..=4).contains(&length_size) {
        return Err(LumaWasmError::InvalidHevc);
    }

    let mut units = Vec::new();
    let mut cursor = 0;
    while cursor + length_size <= data.len() {
        let mut size = 0usize;
        for byte in &data[cursor..cursor + length_size] {
            size = (size << 8) | (*byte as usize);
        }
        cursor += length_size;
        if size == 0 || cursor + size > data.len() || cursor + 2 > data.len() {
            return Err(LumaWasmError::InvalidHevc);
        }
        units.push(NalUnit {
            nal_type: nal_type(data[cursor]),
            offset: cursor,
            size,
        });
        cursor += size;
    }

    Ok(units)
}

pub fn extract_rpu(units: &[NalUnit]) -> Vec<RpuNal> {
    units
        .iter()
        .filter(|unit| unit.nal_type == HEVC_NAL_DV_RPU)
        .enumerate()
        .map(|(index, unit)| RpuNal {
            index,
            nal_type: unit.nal_type,
            offset: unit.offset,
            size: unit.size,
        })
        .collect()
}

pub fn parse_rpu_metadata(rpu_payload: &[u8]) -> Result<CompactDoviMetadata, LumaWasmError> {
    if rpu_payload.len() < 2 {
        return Err(LumaWasmError::InvalidRpu);
    }

    Ok(CompactDoviMetadata::default())
}

pub fn pack_metadata(metadata: &CompactDoviMetadata) -> [f32; COMPACT_DOVI_FLOAT32_COUNT] {
    let mut packed = [0.0; COMPACT_DOVI_FLOAT32_COUNT];
    packed[0..3].copy_from_slice(&metadata.nonlinear_offset);
    packed[4..13].copy_from_slice(&metadata.nonlinear_matrix);
    packed[16..25].copy_from_slice(&metadata.linear_matrix);
    packed[28] = metadata.source_min_pq;
    packed[29] = metadata.source_max_pq;
    packed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_annex_b_rpu() {
        let data = [0, 0, 0, 1, 0x7c, 0x01, 0xaa, 0, 0, 1, 0x26, 0x01, 0xbb];
        let units = parse_annex_b(&data).unwrap();
        assert_eq!(units.len(), 2);
        assert_eq!(units[0].nal_type, HEVC_NAL_DV_RPU);
        assert_eq!(extract_rpu(&units).len(), 1);
    }

    #[test]
    fn parses_length_prefixed_rpu() {
        let data = [0, 0, 0, 3, 0x7c, 0x01, 0xaa, 0, 0, 0, 3, 0x26, 0x01, 0xbb];
        let units = parse_length_prefixed(&data, 4).unwrap();
        assert_eq!(units.len(), 2);
        assert_eq!(units[0].nal_type, HEVC_NAL_DV_RPU);
    }

    #[test]
    fn packs_metadata_with_fixed_layout() {
        let packed = pack_metadata(&CompactDoviMetadata::default());
        assert_eq!(packed.len(), COMPACT_DOVI_FLOAT32_COUNT);
        assert_eq!(packed[4], 1.0);
        assert_eq!(packed[16], 1.0);
        assert_eq!(packed[28], 0.0);
        assert_eq!(packed[29], 1.0);
    }

    #[test]
    fn malformed_rpu_returns_error() {
        assert_eq!(parse_rpu_metadata(&[]).unwrap_err(), LumaWasmError::InvalidRpu);
    }
}
