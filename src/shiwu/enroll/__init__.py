"""注册流程：质量门槛 + 多模板人脸库。"""
from .quality import QualityConfig, QualityResult, check_face_quality, estimate_pose
from .gallery import LocalGallery
from .service import EnrollmentService, EnrollReport, Candidate, choose_templates

__all__ = ["QualityConfig", "QualityResult", "check_face_quality", "estimate_pose", "LocalGallery", "EnrollmentService", "EnrollReport", "Candidate", "choose_templates"]
