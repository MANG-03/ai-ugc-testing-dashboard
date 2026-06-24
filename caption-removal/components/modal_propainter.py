"""
Self-hosted ProPainter on Modal — validation step.
Goal: prove ProPainter runs on a Modal GPU on the WHOLE clip (no external chunking;
ProPainter's own subvideo_length handles memory internally with continuity).

Run: tests/captions/.venv/bin/python -m modal run tests/captions/modal_propainter.py \
        --video /tmp/v5_cfr.mp4 --mask /tmp/v5_cloud_textmask.mp4 --out /tmp/pp_modal.mp4
"""
import modal

app = modal.App("propainter-selfhost")

image = (
    modal.Image.debian_slim(python_version="3.10")
    .apt_install("ffmpeg", "git", "libgl1", "libglib2.0-0")
    .run_commands(
        "git clone https://github.com/sczhou/ProPainter.git /ProPainter",
        "rm -rf /ProPainter/weights && mkdir -p /ProPainter/weights",  # empty so the Volume can mount
    )
    .pip_install(
        "torch==2.1.2", "torchvision==0.16.2",
        "opencv-python-headless", "scipy", "scikit-image", "imageio",
        "imageio-ffmpeg", "av", "einops", "timm", "matplotlib", "tqdm", "numpy<2",
    )
)
# cache the auto-downloaded model weights between runs
weights_vol = modal.Volume.from_name("propainter-weights", create_if_missing=True)


@app.function(image=image, gpu="A100", timeout=1800, memory=32768,
              volumes={"/ProPainter/weights": weights_vol})
def inpaint(video_bytes: bytes, mask_bytes: bytes, neighbor_length: int = 10,
            ref_stride: int = 10, raft_iter: int = 40, subvideo_length: int = 80) -> bytes:
    import os, subprocess, glob, time, shutil
    os.chdir("/ProPainter")
    with open("in.mp4", "wb") as f: f.write(video_bytes)
    with open("m.mp4", "wb") as f: f.write(mask_bytes)
    # ProPainter wants the mask as a DIRECTORY of per-frame PNGs, not a video.
    shutil.rmtree("m_frames", ignore_errors=True); os.makedirs("m_frames")
    subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-i", "m.mp4", "m_frames/%05d.png", "-y"], check=True)
    t0 = time.time()
    subprocess.run([
        "python", "inference_propainter.py",
        "--video", "in.mp4", "--mask", "m_frames", "--output", "results",
        "--mask_dilation", "2", "--ref_stride", str(ref_stride),
        "--neighbor_length", str(neighbor_length), "--subvideo_length", str(subvideo_length),
        "--raft_iter", str(raft_iter), "--save_fps", "30", "--fp16",
    ], check=True)
    weights_vol.commit()
    dt = time.time() - t0
    outs = glob.glob("results/**/inpaint_out.mp4", recursive=True)
    print(f"propainter took {dt:.1f}s, outputs: {outs}")
    if not outs:
        raise RuntimeError("no inpaint_out.mp4 produced: " + str(glob.glob("results/**/*", recursive=True)))
    with open(outs[0], "rb") as f:
        return f.read()


@app.local_entrypoint()
def main(video: str, mask: str, out: str):
    import time
    vb = open(video, "rb").read(); mb = open(mask, "rb").read()
    t0 = time.time()
    res = inpaint.remote(vb, mb)
    open(out, "wb").write(res)
    print(f"TOTAL round-trip {time.time()-t0:.1f}s -> {out}")
