#!/usr/bin/env python3
"""Export a promptable micro-sam checkpoint to the encoder + decoder ONNX pair
the browser SAM tool needs (jit-ui#90), and quantize the encoder to fp16.

This produces the two files the model registry points at via setSamModelUrls():
  <out>/encoder.fp16.onnx   image (1,3,1024,1024)        -> image_embeddings (1,256,64,64)
  <out>/decoder.onnx        embedding + box/point prompts -> masks (resized to orig size)

Prereqs (a GPU box or a CPU box with patience):
  pip install micro_sam segment-anything onnx onnxruntime onnxconverter-common torch

Usage:
  python export_microsam_onnx.py --model-type vit_b_lm --out ./out
  # then host out/*.onnx (HF Hub or GCS) and call setSamModelUrls(...) in the host app.

Notes:
  * micro-sam finetuned checkpoints are standard segment-anything SAM models, so the
    standard SAM ONNX export applies. The `_lm` variants are light-microscopy tuned.
  * Preprocessing (resize long side -> 1024, SAM normalize, pad to 1024) is done in JS
    (onnx-sam-session.ts), so the encoder graph is a pure tensor-in/tensor-out model.
  * This is SAM v1 I/O. SAM2/SAM3 differ (256x256 decoder output, different names).
"""
import argparse
import os
import torch

# micro-sam maps friendly names (vit_b_lm) onto a base ViT size (vit_b).
BASE_VIT = {"vit_t_lm": "vit_t", "vit_b_lm": "vit_b", "vit_l_lm": "vit_l",
            "vit_b": "vit_b", "vit_l": "vit_l", "vit_h": "vit_h", "vit_t": "vit_t"}


def load_sam(model_type: str):
    """Return a segment-anything `Sam` for a micro-sam (or base SAM) model type."""
    from micro_sam.util import get_sam_model
    predictor = get_sam_model(model_type=model_type)   # downloads/caches the checkpoint
    return predictor.model.cpu().eval()


class EncoderWrapper(torch.nn.Module):
    """Image encoder only: (1,3,1024,1024) normalized+padded image -> (1,256,64,64)."""
    def __init__(self, sam):
        super().__init__()
        self.image_encoder = sam.image_encoder

    def forward(self, x):
        return self.image_encoder(x)


def export_encoder(sam, out_dir: str, opset: int) -> str:
    path = os.path.join(out_dir, "encoder.onnx")
    torch.onnx.export(
        EncoderWrapper(sam), torch.randn(1, 3, 1024, 1024),
        path, input_names=["image"], output_names=["image_embeddings"],
        opset_version=opset,
    )
    return path


def export_decoder(sam, model_type: str, out_dir: str, opset: int) -> str:
    """Use segment-anything's SamOnnxModel (prompt encoder + mask decoder + upscale)."""
    from segment_anything.utils.onnx import SamOnnxModel
    path = os.path.join(out_dir, "decoder.onnx")
    onnx_model = SamOnnxModel(sam, return_single_mask=True)
    embed_dim = sam.prompt_encoder.embed_dim
    embed_size = sam.prompt_encoder.image_embedding_size
    dummy = {
        "image_embeddings": torch.randn(1, embed_dim, *embed_size, dtype=torch.float),
        "point_coords": torch.randint(low=0, high=1024, size=(1, 5, 2), dtype=torch.float),
        "point_labels": torch.randint(low=0, high=4, size=(1, 5), dtype=torch.float),
        "mask_input": torch.randn(1, 1, 4 * embed_size[0], 4 * embed_size[1], dtype=torch.float),
        "has_mask_input": torch.tensor([1], dtype=torch.float),
        "orig_im_size": torch.tensor([1500, 2250], dtype=torch.float),
    }
    dynamic_axes = {"point_coords": {1: "num_points"}, "point_labels": {1: "num_points"}}
    with open(path, "wb") as f:
        torch.onnx.export(
            onnx_model, tuple(dummy.values()), f,
            input_names=list(dummy.keys()),
            output_names=["masks", "iou_predictions", "low_res_masks"],
            dynamic_axes=dynamic_axes, opset_version=opset,
        )
    return path


def quantize_fp16(encoder_path: str) -> str:
    """fp16 the encoder — ~2x smaller, ideal for WebGPU. (int8 is possible but
    validate ViT quality; the decoder is tiny and left fp32.)"""
    import onnx
    from onnxconverter_common import float16
    out = encoder_path.replace(".onnx", ".fp16.onnx")
    onnx.save(float16.convert_float_to_float16(onnx.load(encoder_path)), out)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model-type", default="vit_b_lm", choices=sorted(BASE_VIT))
    ap.add_argument("--out", default="./out")
    ap.add_argument("--opset", type=int, default=17)
    ap.add_argument("--no-fp16", action="store_true", help="skip encoder fp16 quantization")
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    sam = load_sam(args.model_type)
    enc = export_encoder(sam, args.out, args.opset)
    dec = export_decoder(sam, BASE_VIT[args.model_type], args.out, args.opset)
    print("wrote", enc)
    print("wrote", dec)
    if not args.no_fp16:
        print("wrote", quantize_fp16(enc))
    print("\nNext: host the .onnx files and call setSamModelUrls('microsam-...', <encoderUrl>, <decoderUrl>).")


if __name__ == "__main__":
    main()
