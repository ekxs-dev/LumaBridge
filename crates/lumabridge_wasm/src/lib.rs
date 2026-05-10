use dolby_vision::rpu::dovi_rpu::DoviRpu;
use dolby_vision::rpu::extension_metadata::blocks::ExtMetadataBlock;
use dolby_vision::rpu::rpu_data_mapping::DoviMappingMethod;
use serde::{Deserialize, Serialize};
use thiserror::Error;
#[cfg(feature = "wasm")]
use wasm_bindgen::prelude::wasm_bindgen;

pub const HEVC_NAL_DV_RPU: u8 = 62;
pub const COMPACT_DOVI_FLOAT32_COUNT: usize = 840;
pub const COMPACT_DOVI_NONLINEAR_OFFSET: usize = 0;
pub const COMPACT_DOVI_NONLINEAR_MATRIX_OFFSET: usize = 4;
pub const COMPACT_DOVI_LINEAR_MATRIX_OFFSET: usize = 16;
pub const COMPACT_DOVI_SOURCE_PQ_OFFSET: usize = 28;
pub const COMPACT_DOVI_RESHAPE_HEADER_OFFSET: usize = 32;
pub const COMPACT_DOVI_PIVOTS_OFFSET: usize = 36;
pub const COMPACT_DOVI_PIECE_META_OFFSET: usize = 72;
pub const COMPACT_DOVI_POLY_COEFFS_OFFSET: usize = 168;
pub const COMPACT_DOVI_MMR_COEFFS_OFFSET: usize = 264;

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
    pub level1_max_pq: f32,
    pub level1_avg_pq: f32,
    pub reshape_header: [f32; 4],
    pub pivots: Vec<f32>,
    pub piece_meta: Vec<f32>,
    pub poly_coeffs: Vec<f32>,
    pub mmr_coeffs: Vec<f32>,
}

impl Default for CompactDoviMetadata {
    fn default() -> Self {
        let mut pivots = vec![0.0; 36];
        let mut piece_meta = vec![0.0; 96];
        let mut poly_coeffs = vec![0.0; 96];
        for component in 0..3 {
            let pivot_base = component * 12;
            pivots[pivot_base] = 0.0;
            pivots[pivot_base + 1] = 1.0;
            let piece_base = component * 8 * 4;
            piece_meta[piece_base] = 0.0;
            piece_meta[piece_base + 3] = 1.0;
            poly_coeffs[piece_base] = 0.0;
            poly_coeffs[piece_base + 1] = 1.0;
            poly_coeffs[piece_base + 2] = 0.0;
        }
        Self {
            nonlinear_offset: [0.0; 3],
            nonlinear_matrix: [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0],
            linear_matrix: [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0],
            source_min_pq: 0.0,
            source_max_pq: 1.0,
            level1_max_pq: 0.0,
            level1_avg_pq: 0.0,
            reshape_header: [0.0, 0.0, 0.0, 0.0],
            pivots,
            piece_meta,
            poly_coeffs,
            mmr_coeffs: vec![0.0; 576],
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
        } else if i + 4 < data.len()
            && data[i] == 0
            && data[i + 1] == 0
            && data[i + 2] == 0
            && data[i + 3] == 1
        {
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
        let end = starts
            .get(index + 1)
            .map(|next| next.0)
            .unwrap_or(data.len());
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

pub fn parse_length_prefixed(
    data: &[u8],
    length_size: usize,
) -> Result<Vec<NalUnit>, LumaWasmError> {
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

    let rpu = parse_unspec62_nalu_lenient(rpu_payload)?;
    compact_metadata_from_dovi_rpu(&rpu).ok_or(LumaWasmError::InvalidRpu)
}

fn parse_unspec62_nalu_lenient(rpu_payload: &[u8]) -> Result<DoviRpu, LumaWasmError> {
    if let Ok(rpu) = DoviRpu::parse_unspec62_nalu(rpu_payload) {
        return Ok(rpu);
    }

    // ffmpeg's single-packet Annex-B copy path can leave non-RPU bytes after
    // the real RPU rbsp terminator. Try shorter candidates ending at 0x80; the
    // dolby_vision parser still validates CRC, so false positives are rejected.
    for end in (25..rpu_payload.len()).rev() {
        if rpu_payload[end - 1] != 0x80 {
            continue;
        }
        if let Ok(rpu) = DoviRpu::parse_unspec62_nalu(&rpu_payload[..end]) {
            return Ok(rpu);
        }
    }

    Err(LumaWasmError::InvalidRpu)
}

fn compact_metadata_from_dovi_rpu(rpu: &DoviRpu) -> Option<CompactDoviMetadata> {
    let header = &rpu.header;
    let mapping = rpu.rpu_data_mapping.as_ref()?;
    let color = rpu.vdr_dm_data.as_ref()?;
    let coefficient_scale = 1.0 / ((1u64 << header.coefficient_log2_denom) as f32);
    let pivot_scale = 1.0 / (((1u64 << (header.bl_bit_depth_minus8 + 8)) - 1) as f32);
    let level1 = color.get_block(1).and_then(|block| match block {
        ExtMetadataBlock::Level1(level1) => Some(level1),
        _ => None,
    });

    let mut metadata = CompactDoviMetadata {
        nonlinear_offset: [
            color.ycc_to_rgb_offset0 as f32 / 268_435_456.0,
            color.ycc_to_rgb_offset1 as f32 / 268_435_456.0,
            color.ycc_to_rgb_offset2 as f32 / 268_435_456.0,
        ],
        nonlinear_matrix: [
            color.ycc_to_rgb_coef0 as f32 / 8192.0,
            color.ycc_to_rgb_coef1 as f32 / 8192.0,
            color.ycc_to_rgb_coef2 as f32 / 8192.0,
            color.ycc_to_rgb_coef3 as f32 / 8192.0,
            color.ycc_to_rgb_coef4 as f32 / 8192.0,
            color.ycc_to_rgb_coef5 as f32 / 8192.0,
            color.ycc_to_rgb_coef6 as f32 / 8192.0,
            color.ycc_to_rgb_coef7 as f32 / 8192.0,
            color.ycc_to_rgb_coef8 as f32 / 8192.0,
        ],
        linear_matrix: [
            color.rgb_to_lms_coef0 as f32 / 16384.0,
            color.rgb_to_lms_coef1 as f32 / 16384.0,
            color.rgb_to_lms_coef2 as f32 / 16384.0,
            color.rgb_to_lms_coef3 as f32 / 16384.0,
            color.rgb_to_lms_coef4 as f32 / 16384.0,
            color.rgb_to_lms_coef5 as f32 / 16384.0,
            color.rgb_to_lms_coef6 as f32 / 16384.0,
            color.rgb_to_lms_coef7 as f32 / 16384.0,
            color.rgb_to_lms_coef8 as f32 / 16384.0,
        ],
        source_min_pq: color.source_min_pq as f32 / 4095.0,
        source_max_pq: color.source_max_pq as f32 / 4095.0,
        level1_max_pq: level1.map_or(0.0, |block| block.max_pq as f32 / 4095.0),
        level1_avg_pq: level1.map_or(0.0, |block| block.avg_pq as f32 / 4095.0),
        ..CompactDoviMetadata::default()
    };

    metadata.reshape_header.fill(0.0);
    metadata.pivots.fill(0.0);
    metadata.piece_meta.fill(0.0);
    metadata.poly_coeffs.fill(0.0);
    metadata.mmr_coeffs.fill(0.0);

    for (component_index, curve) in mapping.curves.iter().enumerate() {
        if component_index >= 3 {
            break;
        }

        let pivot_count = curve.pivots.len().clamp(2, 9);
        metadata.reshape_header[component_index] = pivot_count as f32;
        let pivot_base = component_index * 12;
        let mut cumulative_pivot = 0u32;
        for (pivot_index, pivot) in curve.pivots.iter().take(9).enumerate() {
            cumulative_pivot = if pivot_index == 0 {
                *pivot as u32
            } else {
                cumulative_pivot.saturating_add(*pivot as u32)
            };
            metadata.pivots[pivot_base + pivot_index] = cumulative_pivot as f32 * pivot_scale;
        }

        let piece_count = curve.pivots.len().saturating_sub(1).min(8);
        for piece_index in 0..piece_count {
            let piece_base = (component_index * 8 + piece_index) * 4;
            match curve.mapping_idc {
                DoviMappingMethod::Polynomial => {
                    let Some(poly) = curve.polynomial.as_ref() else {
                        continue;
                    };
                    metadata.piece_meta[piece_base] = 0.0;
                    metadata.piece_meta[piece_base + 3] = poly
                        .poly_coef_int
                        .get(piece_index)
                        .map(|coeffs| coeffs.len())
                        .unwrap_or(0)
                        .max(1) as f32;
                    let coeff_base = piece_base;
                    for coeff_index in 0..3 {
                        let int_part = poly
                            .poly_coef_int
                            .get(piece_index)
                            .and_then(|coeffs| coeffs.get(coeff_index))
                            .copied()
                            .unwrap_or(0);
                        let frac_part = poly
                            .poly_coef
                            .get(piece_index)
                            .and_then(|coeffs| coeffs.get(coeff_index))
                            .copied()
                            .unwrap_or(0) as i64;
                        metadata.poly_coeffs[coeff_base + coeff_index] =
                            ((int_part << header.coefficient_log2_denom) + frac_part) as f32
                                * coefficient_scale;
                    }
                }
                DoviMappingMethod::MMR => {
                    let Some(mmr) = curve.mmr.as_ref() else {
                        continue;
                    };
                    let mmr_order = mmr
                        .mmr_order_minus1
                        .get(piece_index)
                        .copied()
                        .unwrap_or(0)
                        .saturating_add(1)
                        .clamp(1, 3);
                    metadata.piece_meta[piece_base] = 1.0;
                    metadata.piece_meta[piece_base + 3] = mmr_order as f32;
                    let constant_int = mmr.mmr_constant_int.get(piece_index).copied().unwrap_or(0);
                    let constant_frac =
                        mmr.mmr_constant.get(piece_index).copied().unwrap_or(0) as i64;
                    metadata.piece_meta[piece_base + 1] =
                        ((constant_int << header.coefficient_log2_denom) + constant_frac) as f32
                            * coefficient_scale;

                    for order_index in 0..(mmr_order as usize) {
                        let coeff_base =
                            ((component_index * 8 + piece_index) * 3 + order_index) * 8;
                        for coeff_index in 0..7 {
                            let int_part = mmr
                                .mmr_coef_int
                                .get(piece_index)
                                .and_then(|orders| orders.get(order_index))
                                .and_then(|coeffs| coeffs.get(coeff_index))
                                .copied()
                                .unwrap_or(0);
                            let frac_part = mmr
                                .mmr_coef
                                .get(piece_index)
                                .and_then(|orders| orders.get(order_index))
                                .and_then(|coeffs| coeffs.get(coeff_index))
                                .copied()
                                .unwrap_or(0) as i64;
                            write_mmr_coeff(
                                &mut metadata.mmr_coeffs,
                                coeff_base,
                                coeff_index,
                                ((int_part << header.coefficient_log2_denom) + frac_part) as f32
                                    * coefficient_scale,
                            );
                        }
                    }
                }
                DoviMappingMethod::Invalid => {}
            }
        }
    }

    Some(metadata)
}

pub fn pack_metadata(metadata: &CompactDoviMetadata) -> [f32; COMPACT_DOVI_FLOAT32_COUNT] {
    let mut packed = [0.0; COMPACT_DOVI_FLOAT32_COUNT];
    packed[COMPACT_DOVI_NONLINEAR_OFFSET..COMPACT_DOVI_NONLINEAR_OFFSET + 3]
        .copy_from_slice(&metadata.nonlinear_offset);
    pack_vec4_rows(
        &mut packed,
        COMPACT_DOVI_NONLINEAR_MATRIX_OFFSET,
        &metadata.nonlinear_matrix,
        3,
        3,
    );
    pack_vec4_rows(
        &mut packed,
        COMPACT_DOVI_LINEAR_MATRIX_OFFSET,
        &metadata.linear_matrix,
        3,
        3,
    );
    packed[COMPACT_DOVI_SOURCE_PQ_OFFSET] = metadata.source_min_pq;
    packed[COMPACT_DOVI_SOURCE_PQ_OFFSET + 1] = metadata.source_max_pq;
    packed[COMPACT_DOVI_SOURCE_PQ_OFFSET + 2] = metadata.level1_max_pq;
    packed[COMPACT_DOVI_SOURCE_PQ_OFFSET + 3] = metadata.level1_avg_pq;
    packed[COMPACT_DOVI_RESHAPE_HEADER_OFFSET..COMPACT_DOVI_RESHAPE_HEADER_OFFSET + 4]
        .copy_from_slice(&metadata.reshape_header);
    pack_slice(
        &mut packed,
        COMPACT_DOVI_PIVOTS_OFFSET,
        &metadata.pivots,
        36,
    );
    pack_slice(
        &mut packed,
        COMPACT_DOVI_PIECE_META_OFFSET,
        &metadata.piece_meta,
        96,
    );
    pack_slice(
        &mut packed,
        COMPACT_DOVI_POLY_COEFFS_OFFSET,
        &metadata.poly_coeffs,
        96,
    );
    pack_slice(
        &mut packed,
        COMPACT_DOVI_MMR_COEFFS_OFFSET,
        &metadata.mmr_coeffs,
        576,
    );
    packed
}

fn write_mmr_coeff(coeffs: &mut [f32], base: usize, coeff_index: usize, value: f32) {
    let slot = if coeff_index < 3 {
        coeff_index
    } else {
        coeff_index + 1
    };
    if base + slot < coeffs.len() {
        coeffs[base + slot] = value;
    }
}

#[cfg(feature = "wasm")]
#[wasm_bindgen(js_name = parseRpuMetadataPacked)]
pub fn parse_rpu_metadata_packed_wasm(
    rpu_payload: &[u8],
) -> Result<Vec<f32>, wasm_bindgen::JsValue> {
    let metadata = parse_rpu_metadata(rpu_payload)
        .map_err(|error| wasm_bindgen::JsValue::from_str(&error.to_string()))?;
    Ok(pack_metadata(&metadata).to_vec())
}

fn pack_vec4_rows(
    packed: &mut [f32],
    offset: usize,
    values: &[f32],
    row_count: usize,
    row_width: usize,
) {
    for row in 0..row_count {
        for column in 0..row_width {
            packed[offset + row * 4 + column] = values[row * row_width + column];
        }
    }
}

fn pack_slice(packed: &mut [f32], offset: usize, values: &[f32], count: usize) {
    for index in 0..count {
        packed[offset + index] = values.get(index).copied().unwrap_or(0.0);
    }
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
        assert_eq!(COMPACT_DOVI_FLOAT32_COUNT, 840);
        assert_eq!(packed[4], 1.0);
        assert_eq!(packed[9], 1.0);
        assert_eq!(packed[14], 1.0);
        assert_eq!(packed[16], 1.0);
        assert_eq!(packed[28], 0.0);
        assert_eq!(packed[29], 1.0);
        assert_eq!(packed[30], 0.0);
        assert_eq!(packed[31], 0.0);
        assert_eq!(
            &packed[COMPACT_DOVI_RESHAPE_HEADER_OFFSET..COMPACT_DOVI_RESHAPE_HEADER_OFFSET + 4],
            &[0.0, 0.0, 0.0, 0.0]
        );
        assert_eq!(
            &packed[COMPACT_DOVI_POLY_COEFFS_OFFSET..COMPACT_DOVI_POLY_COEFFS_OFFSET + 4],
            &[0.0, 1.0, 0.0, 0.0]
        );
        assert_eq!(
            &packed[COMPACT_DOVI_POLY_COEFFS_OFFSET + 32..COMPACT_DOVI_POLY_COEFFS_OFFSET + 36],
            &[0.0, 1.0, 0.0, 0.0]
        );
        assert_eq!(
            &packed[COMPACT_DOVI_POLY_COEFFS_OFFSET + 64..COMPACT_DOVI_POLY_COEFFS_OFFSET + 68],
            &[0.0, 1.0, 0.0, 0.0]
        );
    }

    #[test]
    fn packs_matrices_with_vec4_row_padding() {
        let mut metadata = CompactDoviMetadata::default();
        metadata.nonlinear_matrix = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0];
        metadata.linear_matrix = [11.0, 12.0, 13.0, 14.0, 15.0, 16.0, 17.0, 18.0, 19.0];
        metadata.source_min_pq = 0.01;
        metadata.source_max_pq = 0.75;
        metadata.level1_max_pq = 0.44;
        metadata.level1_avg_pq = 0.22;
        metadata.pivots[0] = 100.0;
        metadata.piece_meta[0] = 1.0;
        metadata.poly_coeffs[0] = 200.0;
        metadata.mmr_coeffs[575] = 875.0;

        let packed = pack_metadata(&metadata);

        assert_eq!(
            &packed[4..16],
            &[1.0, 2.0, 3.0, 0.0, 4.0, 5.0, 6.0, 0.0, 7.0, 8.0, 9.0, 0.0]
        );
        assert_eq!(
            &packed[16..28],
            &[11.0, 12.0, 13.0, 0.0, 14.0, 15.0, 16.0, 0.0, 17.0, 18.0, 19.0, 0.0]
        );
        assert!((packed[COMPACT_DOVI_SOURCE_PQ_OFFSET] - 0.01).abs() < f32::EPSILON);
        assert!((packed[COMPACT_DOVI_SOURCE_PQ_OFFSET + 1] - 0.75).abs() < f32::EPSILON);
        assert!((packed[COMPACT_DOVI_SOURCE_PQ_OFFSET + 2] - 0.44).abs() < f32::EPSILON);
        assert!((packed[COMPACT_DOVI_SOURCE_PQ_OFFSET + 3] - 0.22).abs() < f32::EPSILON);
        assert_eq!(packed[COMPACT_DOVI_PIVOTS_OFFSET], 100.0);
        assert_eq!(packed[COMPACT_DOVI_PIECE_META_OFFSET], 1.0);
        assert_eq!(packed[COMPACT_DOVI_POLY_COEFFS_OFFSET], 200.0);
        assert_eq!(packed[COMPACT_DOVI_FLOAT32_COUNT - 1], 875.0);
    }

    #[test]
    fn writes_mmr_coefficients_with_libplacebo_vec4_padding() {
        let mut coeffs = vec![0.0; 8];
        for coeff_index in 0..7 {
            write_mmr_coeff(&mut coeffs, 0, coeff_index, (coeff_index + 1) as f32);
        }

        assert_eq!(coeffs, vec![1.0, 2.0, 3.0, 0.0, 4.0, 5.0, 6.0, 7.0]);
    }

    #[test]
    fn malformed_rpu_returns_error() {
        assert_eq!(
            parse_rpu_metadata(&[]).unwrap_err(),
            LumaWasmError::InvalidRpu
        );
    }

    #[test]
    fn parses_real_fixture_rpu_metadata() {
        let bytes = std::fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../tests/fixtures/dv_p5_short.mp4"
        ))
        .unwrap();
        let first_rpu = find_first_fixture_rpu(&bytes).unwrap();
        let metadata = parse_rpu_metadata(first_rpu).unwrap();

        assert!((metadata.nonlinear_offset[1] - 0.5).abs() < 0.0001);
        assert!((metadata.nonlinear_matrix[1] - 799.0 / 8192.0).abs() < 0.0001);
        assert!((metadata.linear_matrix[0] - 17081.0 / 16384.0).abs() < 0.0001);
        assert!((metadata.source_min_pq - 7.0 / 4095.0).abs() < 0.0001);
        assert!((metadata.source_max_pq - 3079.0 / 4095.0).abs() < 0.0001);
        assert!(metadata.level1_max_pq > 0.0);
        assert!(metadata.level1_avg_pq > 0.0);
        assert!(metadata.level1_max_pq > metadata.level1_avg_pq);
        assert!(metadata
            .pivots
            .iter()
            .any(|value| *value > 0.0 && *value < 1.0));
        assert!(metadata.pivots[..9].windows(2).all(|pair| pair[0] <= pair[1]));
        assert!((metadata.pivots[1] - 23.0 / 1023.0).abs() < 0.0001);
        assert!((metadata.pivots[2] - 114.0 / 1023.0).abs() < 0.0001);
        assert!((metadata.pivots[8] - 1021.0 / 1023.0).abs() < 0.0001);
        assert!((metadata.poly_coeffs[0] - 9133.0 / 8_388_608.0).abs() < 0.0001);
        assert!((metadata.poly_coeffs[1] - 17_647_044.0 / 8_388_608.0).abs() < 0.0001);
        assert!(metadata
            .poly_coeffs
            .iter()
            .any(|value| value.abs() > 0.0001));
    }

    fn find_first_fixture_rpu(bytes: &[u8]) -> Option<&[u8]> {
        let mut cursor = 0;
        while cursor + 8 <= bytes.len() {
            let size = u32::from_be_bytes(bytes[cursor..cursor + 4].try_into().ok()?) as usize;
            let box_type = &bytes[cursor + 4..cursor + 8];
            if size < 8 || cursor + size > bytes.len() {
                return None;
            }
            if box_type == b"mdat" {
                let mut sample_cursor = cursor + 8;
                let end = cursor + size;
                while sample_cursor + 4 <= end {
                    let nal_size = u32::from_be_bytes(
                        bytes[sample_cursor..sample_cursor + 4].try_into().ok()?,
                    ) as usize;
                    let payload = sample_cursor + 4;
                    if nal_size == 0 || payload + nal_size > end {
                        return None;
                    }
                    if nal_type(bytes[payload]) == HEVC_NAL_DV_RPU {
                        return Some(&bytes[payload..payload + nal_size]);
                    }
                    sample_cursor = payload + nal_size;
                }
            }
            cursor += size;
        }
        None
    }
}
