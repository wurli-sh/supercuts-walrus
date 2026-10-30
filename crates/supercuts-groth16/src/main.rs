#![forbid(unsafe_code)]

use anyhow::{Context, Result, anyhow, bail};
use ark_bn254::{Bn254, Fq, Fq2, Fr, G1Affine, G2Affine};
use ark_ec::AffineRepr;
use ark_ff::PrimeField;
use ark_groth16::{Groth16, Proof, VerifyingKey, prepare_verifying_key};
use ark_serialize::CanonicalSerialize;
use serde::Serialize;
use serde_json::Value;
use std::{env, fs, path::PathBuf, str::FromStr};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    format: &'static str,
    circuit: String,
    public_input_count: usize,
    fq2_coefficients_swapped: bool,
    verifying_key_hex: String,
    proof_hex: String,
    public_inputs_hex: String,
}

fn main() -> Result<()> {
    let args: Vec<String> = env::args().collect();
    if args.len() != 6 {
        bail!(
            "usage: supercuts-groth16 <circuit> <verification_key.json> <proof.json> <public.json> <output_dir>"
        );
    }
    let circuit = &args[1];
    let vk_json = read_json(&args[2])?;
    let proof_json = read_json(&args[3])?;
    let public_json = read_json(&args[4])?;
    let public_inputs = parse_public_inputs(&public_json)?;

    let mut valid = Vec::new();
    for swapped in [false, true] {
        let (Ok(vk), Ok(proof)) = (
            parse_vk(&vk_json, swapped),
            parse_proof(&proof_json, swapped),
        ) else {
            continue;
        };
        let pvk = prepare_verifying_key(&vk);
        if Groth16::<Bn254>::verify_proof(&pvk, &proof, &public_inputs)
            .context("Arkworks proof verification failed")?
        {
            valid.push((swapped, vk, proof));
        }
    }
    if valid.len() != 1 {
        bail!(
            "expected exactly one valid SnarkJS Fq2 ordering, found {}",
            valid.len()
        );
    }
    let (swapped, vk, proof) = valid.pop().unwrap();
    if vk.gamma_abc_g1.len() != public_inputs.len() + 1 {
        bail!(
            "verifying key expects {} public inputs, proof contains {}",
            vk.gamma_abc_g1.len() - 1,
            public_inputs.len()
        );
    }

    let mut vk_bytes = Vec::new();
    vk.serialize_compressed(&mut vk_bytes)?;
    let mut proof_bytes = Vec::new();
    proof.serialize_compressed(&mut proof_bytes)?;
    let mut public_bytes = Vec::new();
    for input in &public_inputs {
        input.serialize_compressed(&mut public_bytes)?;
    }

    let output_dir = PathBuf::from(&args[5]);
    fs::create_dir_all(&output_dir)?;
    fs::write(output_dir.join("verifying-key.bin"), &vk_bytes)?;
    fs::write(output_dir.join("proof.bin"), &proof_bytes)?;
    fs::write(output_dir.join("public-inputs.bin"), &public_bytes)?;
    let manifest = Manifest {
        format: "arkworks-canonical-compressed-bn254",
        circuit: circuit.clone(),
        public_input_count: public_inputs.len(),
        fq2_coefficients_swapped: swapped,
        verifying_key_hex: hex::encode(vk_bytes),
        proof_hex: hex::encode(proof_bytes),
        public_inputs_hex: hex::encode(public_bytes),
    };
    fs::write(
        output_dir.join("sui-vector.json"),
        format!("{}\n", serde_json::to_string_pretty(&manifest)?),
    )?;
    println!(
        "converted and verified {circuit}: {} public inputs",
        public_inputs.len()
    );
    Ok(())
}

fn read_json(path: &str) -> Result<Value> {
    let bytes = fs::read(path).with_context(|| format!("read {path}"))?;
    serde_json::from_slice(&bytes).with_context(|| format!("parse {path}"))
}

fn parse_public_inputs(value: &Value) -> Result<Vec<Fr>> {
    value
        .as_array()
        .context("public input JSON must be an array")?
        .iter()
        .map(parse_fr)
        .collect()
}

fn parse_vk(value: &Value, swapped: bool) -> Result<VerifyingKey<Bn254>> {
    let ic = value
        .get("IC")
        .and_then(Value::as_array)
        .context("missing IC")?;
    Ok(VerifyingKey {
        alpha_g1: parse_g1(field(value, "vk_alpha_1")?)?,
        beta_g2: parse_g2(field(value, "vk_beta_2")?, swapped)?,
        gamma_g2: parse_g2(field(value, "vk_gamma_2")?, swapped)?,
        delta_g2: parse_g2(field(value, "vk_delta_2")?, swapped)?,
        gamma_abc_g1: ic.iter().map(parse_g1).collect::<Result<_>>()?,
    })
}

fn parse_proof(value: &Value, swapped: bool) -> Result<Proof<Bn254>> {
    Ok(Proof {
        a: parse_g1(field(value, "pi_a")?)?,
        b: parse_g2(field(value, "pi_b")?, swapped)?,
        c: parse_g1(field(value, "pi_c")?)?,
    })
}

fn field<'a>(value: &'a Value, name: &str) -> Result<&'a Value> {
    value.get(name).ok_or_else(|| anyhow!("missing {name}"))
}

fn parse_g1(value: &Value) -> Result<G1Affine> {
    let point = value.as_array().context("G1 point must be an array")?;
    let affine = G1Affine::new_unchecked(parse_fq(at(point, 0)?)?, parse_fq(at(point, 1)?)?);
    if affine.is_zero()
        || !affine.is_on_curve()
        || !affine.is_in_correct_subgroup_assuming_on_curve()
    {
        bail!("invalid G1 point")
    }
    Ok(affine)
}

fn parse_g2(value: &Value, swapped: bool) -> Result<G2Affine> {
    let point = value.as_array().context("G2 point must be an array")?;
    let x = parse_fq2(at(point, 0)?, swapped)?;
    let y = parse_fq2(at(point, 1)?, swapped)?;
    let affine = G2Affine::new_unchecked(x, y);
    if affine.is_zero()
        || !affine.is_on_curve()
        || !affine.is_in_correct_subgroup_assuming_on_curve()
    {
        bail!("invalid G2 point")
    }
    Ok(affine)
}

fn parse_fq2(value: &Value, swapped: bool) -> Result<Fq2> {
    let coefficients = value.as_array().context("Fq2 value must be an array")?;
    let a = parse_fq(at(coefficients, 0)?)?;
    let b = parse_fq(at(coefficients, 1)?)?;
    Ok(if swapped {
        Fq2::new(b, a)
    } else {
        Fq2::new(a, b)
    })
}

fn parse_fq(value: &Value) -> Result<Fq> {
    parse_prime(value, "Fq")
}

fn parse_fr(value: &Value) -> Result<Fr> {
    parse_prime(value, "Fr")
}

fn parse_prime<F: PrimeField + FromStr>(value: &Value, label: &str) -> Result<F> {
    let text = value
        .as_str()
        .context("field value must be a decimal string")?;
    F::from_str(text).map_err(|_| anyhow!("invalid {label} value"))
}

fn at(values: &[Value], index: usize) -> Result<&Value> {
    values
        .get(index)
        .ok_or_else(|| anyhow!("point is missing coordinate {index}"))
}
